"""
Benchmark on-device segmentation with test-time augmentation (TTA) off and on.

Sends the same CT to a running segmentation server several times, once per mode, and reads the stage timings and
peak memory from /runs/{id}. Prints a table and writes benchmark_<date>.csv. Uses only the Python standard library.

Before benchmarking on a Jetson, fix the clocks so results are comparable:
    sudo nvpmodel -m 0        # MAXN (check the mode number for your board with: sudo nvpmodel -q)
    sudo jetson_clocks

Usage:
    python benchmark.py ct.nii.gz                       # TTA off and on, 3 runs each
    python benchmark.py ct.nii.gz --modes off --runs 5
    python benchmark.py ct.nii.gz --url http://192.168.0.191:8000 --key change-me
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path


def post_segment(url: str, key: str, ct: Path, tta: str) -> str:
    req = urllib.request.Request(
        url.rstrip("/") + "/segment", data=ct.read_bytes(), method="POST",
        headers={"Content-Type": "application/octet-stream", "X-Filename": ct.name, "X-Api-Key": key, "X-TTA": tta},
    )
    with urllib.request.urlopen(req, timeout=3600) as r:
        r.read()
        return r.headers.get("X-Run-Id", "")


def get_run(url: str, key: str, run_id: str) -> dict:
    req = urllib.request.Request(url.rstrip("/") + f"/runs/{run_id}", headers={"X-Api-Key": key})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def power_mode() -> str:
    try:
        out = subprocess.run(["nvpmodel", "-q"], capture_output=True, text=True, timeout=5).stdout
        return " ".join(out.split())[:80] or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown (nvpmodel not found)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ct", help="CT volume (.nii or .nii.gz)")
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--key", default="change-me", help="the server's API_KEY")
    ap.add_argument("--modes", nargs="+", default=["off", "on"], choices=["off", "on"])
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--target", type=float, default=300, help="target seconds per volume (default 300 = 5 min)")
    args = ap.parse_args()

    ct = Path(args.ct).expanduser()
    print(f"CT {ct.name} ({ct.stat().st_size / 1e6:.1f} MB) · server {args.url} · power mode: {power_mode()}")
    rows = []
    for mode in args.modes:
        for i in range(1, args.runs + 1):
            print(f"TTA {mode} · run {i}/{args.runs} … ", end="", flush=True)
            t0 = time.time()
            try:
                run_id = post_segment(args.url, args.key, ct, mode)
            except Exception as e:  # noqa: BLE001
                print(f"failed: {e}")
                continue
            client_s = time.time() - t0
            run = get_run(args.url, args.key, run_id) if run_id else {}
            st = run.get("stages", {})
            mem = [s.get("mem_used_mb") for s in run.get("samples", []) if s.get("mem_used_mb") is not None]
            gpu = [s.get("gpu_util") for s in run.get("samples", []) if s.get("gpu_util") is not None]
            row = {
                "tta": mode, "run": i, "run_id": run_id, "device": run.get("device", ""),
                "total_s": round(client_s, 1), "server_s": run.get("wall_s"),
                "inference_s": st.get("inference"), "vertebra_s": st.get("vertebra_detection"),
                "peak_mem_mb": max(mem) if mem else None, "mean_gpu_pct": round(statistics.mean(gpu), 1) if gpu else None,
            }
            rows.append(row)
            print(f"inference {row['inference_s']} s · total {row['total_s']} s · peak memory {row['peak_mem_mb']} MB")

    if not rows:
        return 1
    print()
    print(f"{'TTA':<5}{'runs':>5}{'inference s (mean)':>20}{'total s (mean)':>16}{'peak MB':>9}  target {args.target:.0f} s")
    for mode in args.modes:
        rs = [r for r in rows if r["tta"] == mode]
        if not rs:
            continue
        inf = [r["inference_s"] for r in rs if r["inference_s"] is not None]
        tot = [r["total_s"] for r in rs]
        peak = max((r["peak_mem_mb"] or 0) for r in rs)
        m_tot = statistics.mean(tot)
        print(f"{mode:<5}{len(rs):>5}{(statistics.mean(inf) if inf else float('nan')):>20.1f}{m_tot:>16.1f}{peak:>9.0f}  "
              f"{'meets target' if m_tot <= args.target else 'over target'}")

    out = Path(f"benchmark_{datetime.now():%Y%m%d_%H%M%S}.csv")
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nSaved {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
