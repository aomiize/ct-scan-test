"""
Segmentation server for BodyComp.

POST /segment      body: raw .nii / .nii.gz bytes, header X-Filename: ct.nii.gz
                   → 200 with a .nii.gz label mask on the same grid as the CT.
                     Headers: X-Label-Scheme (generic | totalseg), X-Run-Id
GET  /runs/{id}    log lines, stage timings and resource samples for one run
GET  /device       current device and GPU status
GET  /health

MODEL (env var) picks the backend:
  totalseg  TotalSegmentator --task tissue_types   (labels: 1 SAT, 2 torso fat, 3 muscle)
            tissue_types needs a TotalSegmentator licence (free for non-commercial use).
  nnunet    nnUNetv2_predict with NNUNET_DATASET / NNUNET_CONFIG / NNUNET_FOLDS
            (your own model; set LABEL_SCHEME=generic or totalseg to match its label numbers)
  demo      HU thresholds only (generic labels: 1 muscle-range, 3 fat-range). Pipeline test only.

GPU sampling uses nvidia-smi when present, tegrastats on Jetson, otherwise CPU/RAM via psutil.

Run:  pip install -r requirements.txt
      MODEL=totalseg API_KEY=change-me uvicorn server:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

MODEL = os.environ.get("MODEL", "demo")
API_KEY = os.environ.get("API_KEY", "")
MAX_BYTES = 1024**3
KEEP_RUNS = 50

app = FastAPI(title="BodyComp segmentation")


# ---------------------------------------------------------------- resources
class Sampler:
    """Reads GPU/CPU state. One shared tegrastats process on Jetson; nvidia-smi or psutil elsewhere."""

    def __init__(self) -> None:
        self.kind = "none"
        self.latest: dict = {}
        self.device = self._device_name()
        if shutil.which("tegrastats"):
            self.kind = "tegrastats"
            threading.Thread(target=self._tegra_loop, daemon=True).start()
        elif shutil.which("nvidia-smi"):
            self.kind = "nvidia-smi"
        else:
            try:
                import psutil  # noqa: F401
                self.kind = "psutil"
            except ImportError:
                self.kind = "none"

    @staticmethod
    def _device_name() -> str:
        p = Path("/proc/device-tree/model")
        if p.exists():
            return p.read_text(errors="ignore").strip("\x00 \n")
        if shutil.which("nvidia-smi"):
            try:
                return subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                                      capture_output=True, text=True, timeout=5).stdout.strip().splitlines()[0]
            except Exception:  # noqa: BLE001
                pass
        return os.uname().nodename

    def _tegra_loop(self) -> None:
        proc = subprocess.Popen(["tegrastats", "--interval", "500"], stdout=subprocess.PIPE, text=True)
        assert proc.stdout
        for line in proc.stdout:
            s: dict = {}
            if m := re.search(r"RAM (\d+)/(\d+)MB", line):
                s["mem_used_mb"], s["mem_total_mb"] = int(m[1]), int(m[2])  # unified memory on Jetson
            if m := re.search(r"GR3D_FREQ (\d+)%", line):
                s["gpu_util"] = int(m[1])
            if m := re.search(r"(?:gpu|GPU)@([\d.]+)C", line):
                s["temp_c"] = float(m[1])
            if m := re.search(r"VDD_IN (\d+)mW", line):
                s["power_w"] = int(m[1]) / 1000
            self.latest = s

    def sample(self) -> dict:
        if self.kind == "tegrastats":
            return dict(self.latest)
        if self.kind == "nvidia-smi":
            try:
                out = subprocess.run(
                    ["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
                     "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3).stdout
                v = [x.strip() for x in out.splitlines()[0].split(",")]
                num = lambda x: float(x) if re.match(r"^[\d.]+$", x) else None  # noqa: E731
                return {"mem_used_mb": num(v[0]), "mem_total_mb": num(v[1]), "gpu_util": num(v[2]),
                        "temp_c": num(v[3]), "power_w": num(v[4])}
            except Exception:  # noqa: BLE001
                return {}
        if self.kind == "psutil":
            import psutil
            vm = psutil.virtual_memory()
            return {"mem_used_mb": round(vm.used / 2**20), "mem_total_mb": round(vm.total / 2**20),
                    "cpu_util": psutil.cpu_percent(interval=None)}
        return {}


SAMPLER = Sampler()


# ---------------------------------------------------------------- runs
class Run:
    def __init__(self, filename: str, size: int) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.filename = filename
        self.bytes = size
        self.model = MODEL
        self.started = time.time()
        self.finished: float | None = None
        self.status = "running"
        self.stages: dict[str, float] = {}
        self.logs: list[dict] = []
        self.samples: list[dict] = []
        self._stop = threading.Event()
        threading.Thread(target=self._sample_loop, daemon=True).start()

    def log(self, level: str, tag: str, msg: str) -> None:
        self.logs.append({"t": datetime.now().isoformat(timespec="milliseconds"), "level": level, "tag": tag, "msg": msg})
        print(f"[{self.id}] {level} {tag} {msg}", flush=True)

    def stage(self, name: str):
        run = self

        class _S:
            def __enter__(self):
                self.t0 = time.time()
                run.log("INFO", name.upper(), "started")

            def __exit__(self, *exc):
                dt = time.time() - self.t0
                run.stages[name] = round(dt, 2)
                run.log("INFO" if not exc[0] else "ERROR", name.upper(), f"{'finished' if not exc[0] else 'failed'} in {dt:.2f}s")
                return False

        return _S()

    def _sample_loop(self) -> None:
        while not self._stop.is_set():
            s = SAMPLER.sample()
            if s:
                s["t"] = round(time.time() - self.started, 2)
                self.samples.append(s)
            self._stop.wait(0.5)

    def finish(self, status: str) -> None:
        self._stop.set()
        s = SAMPLER.sample()  # closing sample, so even a short run has a start and an end point
        if s:
            s["t"] = round(time.time() - self.started, 2)
            self.samples.append(s)
        self.status = status
        self.finished = time.time()

    def to_dict(self) -> dict:
        return {"id": self.id, "filename": self.filename, "bytes": self.bytes, "model": self.model,
                "device": SAMPLER.device, "sampler": SAMPLER.kind,
                "started": datetime.fromtimestamp(self.started).isoformat(timespec="seconds"),
                "wall_s": round((self.finished or time.time()) - self.started, 2),
                "status": self.status, "stages": self.stages, "logs": self.logs, "samples": self.samples}


RUNS: "OrderedDict[str, Run]" = OrderedDict()


def remember(run: Run) -> None:
    RUNS[run.id] = run
    while len(RUNS) > KEEP_RUNS:
        RUNS.popitem(last=False)


def check_key(key: str) -> None:
    if API_KEY and key != API_KEY:
        raise HTTPException(401, "Wrong or missing X-Api-Key.")


# ---------------------------------------------------------------- routes
@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.get("/device")
def device(x_api_key: str = Header("")):
    check_key(x_api_key)
    busy = any(r.status == "running" for r in RUNS.values())
    return {"device": SAMPLER.device, "model": MODEL, "sampler": SAMPLER.kind, "busy": busy, **SAMPLER.sample()}


@app.get("/runs/{run_id}")
def get_run(run_id: str, x_api_key: str = Header("")):
    check_key(x_api_key)
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "Unknown run id.")
    return run.to_dict()


@app.post("/segment")
async def segment(request: Request, x_filename: str = Header("ct.nii.gz"), x_api_key: str = Header("")):
    check_key(x_api_key)
    name = Path(unquote(x_filename)).name
    suffix = ".nii.gz" if name.lower().endswith(".gz") else ".nii"
    work = Path(tempfile.mkdtemp(prefix="bodycomp_"))
    ct = work / f"ct_0000{suffix}"

    run = Run(name, 0)
    remember(run)
    run.log("INFO", "PIPELINE", f"run {run.id} on {SAMPLER.device} with model '{MODEL}'")
    try:
        with run.stage("receive"):
            size = 0
            with ct.open("wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "CT larger than 1 GB.")
                    f.write(chunk)
            run.bytes = size
            run.log("DEBUG", "RECEIVE", f"{name}: {size / 1e6:.1f} MB written to scratch")
        out = run_model(run, ct, work)
    except HTTPException:
        run.finish("failed")
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as e:  # noqa: BLE001
        run.log("ERROR", "PIPELINE", str(e)[-400:])
        run.finish("failed")
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(500, f"Model failed: {str(e)[-400:]}")

    run.finish("completed")
    run.log("SUCCESS", "PIPELINE", f"completed in {run.to_dict()['wall_s']}s")
    scheme = {"totalseg": "totalseg", "demo": "generic"}.get(MODEL, os.environ.get("LABEL_SCHEME", "generic"))
    return FileResponse(out, media_type="application/octet-stream",
                        headers={"X-Label-Scheme": scheme, "X-Run-Id": run.id},
                        background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))


def stream_cmd(run: Run, cmd: list[str], tag: str) -> None:
    """Run a command and copy its output into the run log line by line."""
    run.log("DEBUG", tag, " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail: list[str] = []
    assert proc.stdout
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail = (tail + [line])[-20:]
        level = "WARN" if re.search(r"warn", line, re.I) else "ERROR" if re.search(r"error|traceback", line, re.I) else "DEBUG"
        run.log(level, tag, line[:400])
    if proc.wait() != 0:
        raise RuntimeError(f"{cmd[0]} exited with code {proc.returncode}: " + " | ".join(tail[-3:]))


def run_model(run: Run, ct: Path, work: Path) -> Path:
    if MODEL == "totalseg":
        out = work / "tissue.nii.gz"
        with run.stage("inference"):
            stream_cmd(run, ["TotalSegmentator", "-i", str(ct), "-o", str(out), "--task", "tissue_types", "--ml"], "TOTALSEG")
        return out

    if MODEL == "nnunet":
        inp, outdir = work / "in", work / "out"
        with run.stage("preprocess"):
            inp.mkdir()
            ct.rename(inp / ("case_0000.nii.gz" if ct.name.endswith(".gz") else "case_0000.nii"))
        cmd = ["nnUNetv2_predict", "-i", str(inp), "-o", str(outdir),
               "-d", os.environ["NNUNET_DATASET"], "-c", os.environ.get("NNUNET_CONFIG", "3d_fullres")]
        if folds := os.environ.get("NNUNET_FOLDS"):
            cmd += ["-f", *folds.split()]
        with run.stage("inference"):
            stream_cmd(run, cmd, "NNUNET")
        found = sorted(outdir.glob("case.nii*"))
        if not found:
            raise RuntimeError("nnU-Net produced no output file.")
        return found[0]

    if MODEL == "demo":
        import nibabel as nib
        import numpy as np

        with run.stage("preprocess"):
            img = nib.load(str(ct))
            hu = np.asanyarray(img.dataobj).astype(np.float32)
            run.log("DEBUG", "PREPROCESS", f"grid {hu.shape}, spacing {tuple(round(float(z), 3) for z in img.header.get_zooms()[:3])}")
        with run.stage("inference"):
            lab = np.zeros(hu.shape, np.uint8)
            lab[(hu >= -29) & (hu <= 150)] = 1
            lab[(hu >= -190) & (hu <= -30)] = 3
        with run.stage("postprocess"):
            counts = {int(k): int(v) for k, v in zip(*np.unique(lab, return_counts=True)) if k}
            run.log("DEBUG", "POSTPROCESS", f"label voxel counts {counts}")
            out = work / "demo_seg.nii.gz"
            seg = nib.Nifti1Image(lab, img.affine, img.header)
            seg.set_data_dtype(np.uint8)
            seg.header.set_slope_inter(1, 0)
            nib.save(seg, str(out))
        run.log("WARN", "PIPELINE", "demo model uses HU thresholds only; do not report these values")
        return out

    raise RuntimeError(f"Unknown MODEL '{MODEL}'. Use totalseg, nnunet or demo.")
