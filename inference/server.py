"""
Segmentation server for BodyComp.

POST /segment      body: raw .nii / .nii.gz bytes, header X-Filename: ct.nii.gz
                   → 200 with a .nii.gz label mask on the same grid as the CT.
                     Headers: X-Labels (label number → name), X-Label-Scheme (generic | totalseg), X-Run-Id
POST /convert      body: a .zip of one DICOM study (any folder layout), header X-Series-Id optional
                   → 200 with the series as .nii.gz (patient metadata is not carried over).
                     Headers: X-Series (JSON list of series found), X-Series-Chosen
GET  /runs/{id}    log lines, stage timings and resource samples for one run
GET  /device       current device and GPU status
GET  /health

MODEL (env var) picks the backend:
  totalseg  TotalSegmentator, task from TOTALSEG_TASK (default tissue_types: 1 SAT, 2 torso fat, 3 muscle).
            tissue_types needs a TotalSegmentator licence (free for non-commercial use):
              totalseg_set_license -l <your key>
            AUTO_L3=1 (default) also runs the free "total" model on the vertebrae in VERTEBRAE (default "T12 L3 L4")
            and adds them as labels 50 (L3), 51 (T12), 52 (L4), so the viewer sets the L3 slice and the T12–L4
            range by itself. TOTALSEG_FAST=1 uses the faster 3 mm models.
            TOTALSEG_THREADS=1 lowers memory use (fewer worker processes).
  nnunet    nnU-Net v2. Either a model folder you downloaded (NNUNET_MODEL_FOLDER, NNUNET_FOLDS, NNUNET_CHECKPOINT)
            or a dataset in nnUNet_results (NNUNET_DATASET / NNUNET_CONFIG / NNUNET_FOLDS).
            Label names come from the model folder's dataset.json. AUTO_L3 also applies if TotalSegmentator is installed.
            NNUNET_THREADS=1 lowers memory use; NNUNET_DEVICE=cpu forces CPU.
            DISABLE_TTA=1 (default) turns off mirroring test-time augmentation, the largest speed win.
            CROP_T12_L4=1 (default, with AUTO_L3) finds the vertebrae first and segments only T12-L4 plus
            CROP_MARGIN_MM (20) mm, instead of every slice of the scan.
            A request can override it with the header X-TTA: on | off (used by benchmark.py).
            nnU-Net already runs in mixed precision (FP16) on the GPU.
            (your own model; set LABEL_SCHEME=generic or totalseg to match its label numbers)
  demo      HU thresholds only (generic labels: 1 muscle-range, 3 fat-range). Pipeline test only.

GPU sampling uses nvidia-smi when present, tegrastats on Jetson, otherwise CPU/RAM via psutil.

Run:  pip install -r requirements.txt
      MODEL=totalseg API_KEY=change-me uvicorn server:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

MODEL = os.environ.get("MODEL", "demo")
TOTALSEG_TASK = os.environ.get("TOTALSEG_TASK", "tissue_types")
AUTO_L3 = os.environ.get("AUTO_L3", "1") == "1"
TOTALSEG_FAST = os.environ.get("TOTALSEG_FAST", "0") == "1"
# Worker processes for resampling/saving. Fewer = less memory (each worker can hold a copy of the volume).
TOTALSEG_THREADS = os.environ.get("TOTALSEG_THREADS", "")
L3_LABEL = 50
# Vertebrae found by TotalSegmentator and merged into the mask. L3 sets the analysis slice; T12 and L4 bound the
# T12–L4 range used for the volume metrics.
VERTEBRAE = os.environ.get("VERTEBRAE", "T12 L3 L4").split()
VERT_LABELS = {"L3": 50, "T12": 51, "L4": 52, "L1": 53, "L2": 54, "L5": 55, "T11": 56}
DISABLE_TTA = os.environ.get("DISABLE_TTA", "1") == "1"
# With vertebra detection on, find T12-L4 first and run nnU-Net only on that slab (plus a margin). The model works
# slice by slice, so time falls with the number of slices; a chest-abdomen-pelvis scan often has 3x more than needed.
CROP_T12_L4 = os.environ.get("CROP_T12_L4", "1") == "1"
CROP_MARGIN_MM = float(os.environ.get("CROP_MARGIN_MM", "20"))
API_KEY = os.environ.get("API_KEY", "")
MAX_BYTES = 1024**3
KEEP_RUNS = 50

app = FastAPI(title="BodyComp segmentation")


def resolve_model_folder(path: str) -> str:
    """Return the model folder, forgiving a lost "__" (chat apps often eat double underscores when a command is
    copied). Prints a clear message at startup instead of failing on the first run."""
    if not path:
        return path
    p = Path(path).expanduser()
    if (p / "dataset.json").exists():
        return str(p)
    key = re.sub(r"_", "", p.name).lower()
    if p.parent.is_dir():
        for c in p.parent.iterdir():
            if c.is_dir() and re.sub(r"_", "", c.name).lower() == key and (c / "dataset.json").exists():
                print(f"NNUNET_MODEL_FOLDER {p} not found; using {c}", flush=True)
                return str(c)
    print(f"WARNING: NNUNET_MODEL_FOLDER {p} has no dataset.json. Check the folder name "
          f"(it contains double underscores: nnUNetTrainer__<Plans>__<config>).", flush=True)
    return str(p)


if os.environ.get("NNUNET_MODEL_FOLDER"):
    os.environ["NNUNET_MODEL_FOLDER"] = resolve_model_folder(os.environ["NNUNET_MODEL_FOLDER"])


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
        self.tta: bool | None = None
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
                "status": self.status, "tta": self.tta, "stages": self.stages, "logs": self.logs, "samples": self.samples}


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
async def segment(request: Request, x_filename: str = Header("ct.nii.gz"), x_api_key: str = Header(""), x_tta: str = Header("")):
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
        tta = {"on": True, "off": False}.get(x_tta.strip().lower(), not DISABLE_TTA)
        out, labels = run_model(run, ct, work, tta)
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
    headers = {"X-Label-Scheme": scheme, "X-Run-Id": run.id}
    if run.tta is not None:
        headers["X-TTA"] = "on" if run.tta else "off"
    if labels:
        headers["X-Labels"] = quote(json.dumps({str(k): v for k, v in labels.items()}))
    return FileResponse(out, media_type="application/octet-stream",
                        headers=headers,
                        background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))


@app.post("/convert")
async def convert(request: Request, x_api_key: str = Header(""), x_series_id: str = Header("")):
    """DICOM .zip → NIfTI of one series (the CT series with the most slices unless X-Series-Id picks another)."""
    check_key(x_api_key)
    try:
        import SimpleITK as sitk
    except ImportError:
        raise HTTPException(501, "DICOM conversion needs SimpleITK on the inference server: pip install SimpleITK")
    work = Path(tempfile.mkdtemp(prefix="bodycomp_dcm_"))
    try:
        zpath = work / "upload.zip"
        size = 0
        with zpath.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BYTES * 2:
                    raise HTTPException(413, "DICOM upload larger than 2 GB.")
                f.write(chunk)
        dicom_dir = work / "dicom"
        dicom_dir.mkdir()
        try:
            with zipfile.ZipFile(zpath) as z:
                # Extract into one flat folder with generated names: series are then grouped by their UIDs,
                # whatever folder layout the zip had, and no member name can escape the scratch folder.
                n = 0
                for m in z.infolist():
                    if m.is_dir() or m.file_size == 0:
                        continue
                    n += 1
                    with z.open(m) as src, (dicom_dir / f"f{n:06d}.dcm").open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile:
            raise HTTPException(400, "The upload is not a valid .zip file.")
        zpath.unlink()

        series: dict[str, dict] = {}
        for sid in sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(dicom_dir)) or []:
            # GDCM returns the files of a series sorted by slice position
            series[sid] = {"files": list(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(dicom_dir), sid))}
        if not series:
            raise HTTPException(422, "No DICOM image series found in the upload.")
        for info in series.values():
            try:
                r = sitk.ImageFileReader()
                r.SetFileName(info["files"][0])
                r.ReadImageInformation()
                get = lambda tag: r.GetMetaData(tag).strip() if r.HasMetaDataKey(tag) else ""  # noqa: E731
                info["description"], info["modality"] = get("0008|103e"), get("0008|0060")
            except Exception:  # noqa: BLE001
                info["description"], info["modality"] = "", ""
        listing = [{"id": k, "slices": len(v["files"]), "description": v["description"], "modality": v["modality"]}
                   for k, v in sorted(series.items(), key=lambda kv: -len(kv[1]["files"]))]
        chosen = x_series_id if x_series_id in series else next(
            (s["id"] for s in listing if s["modality"] in ("CT", "") and s["slices"] >= 10), listing[0]["id"])

        reader = sitk.ImageSeriesReader()
        reader.SetFileNames(series[chosen]["files"])
        img = reader.Execute()  # applies rescale slope/intercept, so values are HU
        img = sitk.Cast(sitk.Clamp(img, lowerBound=-32768, upperBound=32767), sitk.sitkInt16)
        out = work / "ct.nii.gz"
        sitk.WriteImage(img, str(out))  # NIfTI keeps geometry only: no names, IDs or dates
        print(f"converted series {chosen} ({len(series[chosen]['files'])} files, {size / 1e6:.1f} MB zip)", flush=True)
        return FileResponse(out, media_type="application/octet-stream",
                            headers={"X-Series": quote(json.dumps(listing)), "X-Series-Chosen": chosen},
                            background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(500, f"DICOM conversion failed: {str(e)[-300:]}")


def stream_cmd(run: Run, cmd: list[str], tag: str) -> None:
    """Run a command and copy its output into the run log line by line.

    Tools (nnUNetv2_*, TotalSegmentator) are taken from the same environment as this server's Python, so an
    activated conda/venv in the terminal cannot swap in a different installation."""
    import sys
    own = Path(sys.executable).parent / cmd[0]
    if own.exists():
        cmd = [str(own), *cmd[1:]]
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


def totalseg_labels(task: str) -> dict[int, str]:
    """Label number → name for a TotalSegmentator task, read from the installed package."""
    try:
        from totalsegmentator.map_to_binary import class_map
        return {int(k): str(v) for k, v in class_map[task].items()}
    except Exception:  # noqa: BLE001
        return {1: "subcutaneous_fat", 2: "torso_fat", 3: "skeletal_muscle"} if task == "tissue_types" else {}


def nnunet_labels(folder: str) -> dict[int, str] | None:
    """Label number → name from the model folder's dataset.json ({"labels": {"background": 0, "muscle": 1, …}})."""
    try:
        labels = json.loads((Path(folder) / "dataset.json").read_text())["labels"]
        out: dict[int, str] = {}
        for name, value in labels.items():
            if isinstance(value, (list, tuple)):  # region-based training: skip regions
                continue
            if int(value) > 0:
                out[int(value)] = str(name)
        return out or None
    except Exception:  # noqa: BLE001
        return None


def find_vertebrae(run: Run, ct: Path, work: Path) -> dict:
    """Run TotalSegmentator's free "total" model on VERTEBRAE. Returns {roi name: boolean array} for the ones found.

    Each vertebra is saved as its own file (no --ml), so label numbering inside TotalSegmentator does not matter."""
    import nibabel as nib
    import numpy as np

    rois = [f"vertebrae_{v}" for v in VERTEBRAE if v in VERT_LABELS]
    if not rois:
        return {}
    outdir = work / "vertebrae"
    fast = ["--fast"] if TOTALSEG_FAST else []
    if TOTALSEG_THREADS:
        fast += ["-nr", TOTALSEG_THREADS, "-ns", TOTALSEG_THREADS]
    with run.stage("vertebra_detection"):
        stream_cmd(run, ["TotalSegmentator", "-i", str(ct), "-o", str(outdir), "--roi_subset", *rois, *fast], "TOTALSEG-VERT")
    found = {}
    for roi in rois:
        f = outdir / f"{roi}.nii.gz"
        if not f.exists():
            run.log("WARN", "VERTEBRAE", f"{roi}: no output file")
            continue
        sel = np.asanyarray(nib.load(str(f)).dataobj) > 0
        if not sel.any():
            run.log("WARN", "VERTEBRAE", f"{roi} is not inside the scanned range")
            continue
        found[roi] = sel
        run.log("INFO", "VERTEBRAE", f"{roi} found: {int(sel.sum())} voxels")
    return found


def merge_vertebrae(run: Run, tissue: Path, found: dict) -> dict[int, str]:
    """Write found vertebrae into the tissue mask as labels 50+ (bone does not overlap soft tissue)."""
    import nibabel as nib
    import numpy as np

    if not found:
        return {}
    t_img = nib.load(str(tissue))
    t = np.asanyarray(t_img.dataobj).astype(np.uint8)
    added: dict[int, str] = {}
    for roi, sel in found.items():
        if sel.shape != t.shape:
            raise RuntimeError(f"{roi} mask shape {sel.shape} differs from tissue mask {t.shape}")
        label = VERT_LABELS[roi.split("_", 1)[1]]
        t[sel] = label
        added[label] = roi
    out = nib.Nifti1Image(t, t_img.affine, t_img.header)
    out.set_data_dtype(np.uint8)
    out.header.set_slope_inter(1, 0)
    nib.save(out, str(tissue))
    run.log("INFO", "VERTEBRAE", "added " + ", ".join(f"{r} → label {l}" for l, r in added.items()))
    return added


def detect_vertebrae(run: Run, ct: Path, tissue: Path, work: Path) -> dict[int, str]:
    """Find VERTEBRAE and write them into the tissue mask. Returns the labels that were added."""
    return merge_vertebrae(run, tissue, find_vertebrae(run, ct, work))


def crop_range(img, found: dict) -> tuple[int, int, int] | None:
    """Slice range covering T12 to L4 plus CROP_MARGIN_MM, along the head-feet axis of the voxel grid.

    Returns (axis, start, stop) or None when T12 and L4 were not both found."""
    import numpy as np

    if "vertebrae_T12" not in found or "vertebrae_L4" not in found:
        return None
    axis = int(np.argmax(np.abs(img.affine[2, :3])))  # voxel axis closest to the superior direction
    idx = []
    for roi in ("vertebrae_T12", "vertebrae_L4"):
        other = tuple(a for a in range(3) if a != axis)
        hits = np.where(found[roi].any(axis=other))[0]
        idx += [int(hits.min()), int(hits.max())]
    spacing = float(img.header.get_zooms()[axis])
    margin = int(np.ceil(CROP_MARGIN_MM / max(spacing, 1e-3)))
    n = img.shape[axis]
    start, stop = max(0, min(idx) - margin), min(n, max(idx) + margin + 1)
    if stop - start >= n:
        return None  # nothing to gain
    return axis, start, stop


def run_model(run: Run, ct: Path, work: Path, tta: bool = False) -> tuple[Path, dict[int, str] | None]:
    if MODEL == "totalseg":
        out = work / "tissue.nii.gz"
        fast = ["--fast"] if TOTALSEG_FAST else []
        if TOTALSEG_THREADS:
            fast += ["-nr", TOTALSEG_THREADS, "-ns", TOTALSEG_THREADS]
        with run.stage("inference"):
            stream_cmd(run, ["TotalSegmentator", "-i", str(ct), "-o", str(out), "--task", TOTALSEG_TASK, "--ml", *fast], "TOTALSEG")
        labels = totalseg_labels(TOTALSEG_TASK)
        if AUTO_L3:
            try:
                labels.update(detect_vertebrae(run, ct, out, work))
            except Exception as e:  # noqa: BLE001  landmarks are a convenience; keep the tissue mask if it fails
                run.log("WARN", "VERTEBRAE", f"automatic vertebra detection failed, set L3 by hand: {str(e)[-200:]}")
        return out, labels

    if MODEL == "nnunet":
        import nibabel as nib
        import numpy as np

        inp, outdir = work / "in", work / "out"
        have_ts = shutil.which("TotalSegmentator") or (Path(__import__("sys").executable).parent / "TotalSegmentator").exists()
        found: dict | None = None
        crop = None
        full_img = None
        inp.mkdir()
        case = inp / ("case_0000.nii.gz" if ct.name.endswith(".gz") else "case_0000.nii")
        if AUTO_L3 and have_ts and CROP_T12_L4:
            try:
                found = find_vertebrae(run, ct, work)
                full_img = nib.load(str(ct))
                crop = crop_range(full_img, found)
            except Exception as e:  # noqa: BLE001
                run.log("WARN", "VERTEBRAE", f"automatic vertebra detection failed, segmenting every slice: {str(e)[-200:]}")
                found, crop = {}, None
        with run.stage("preprocess"):
            if crop:
                axis, start, stop = crop
                sl = [slice(None)] * 3
                sl[axis] = slice(start, stop)
                nib.save(full_img.slicer[tuple(sl)], str(case))
                n = full_img.shape[axis]
                run.log("INFO", "CROP", f"segmenting slices {start + 1}-{stop} of {n} (T12-L4 plus {CROP_MARGIN_MM:g} mm): "
                                        f"{stop - start} instead of {n}")
            else:
                if found is not None:
                    run.log("INFO", "CROP", "T12 and L4 not both found; segmenting every slice")
                ct.rename(case)
        folder = os.environ.get("NNUNET_MODEL_FOLDER", "")
        if folder:
            # A trained model folder copied as-is (plans.json, dataset.json, fold_X/checkpoint_*.pth),
            # e.g. the Mazurowski-lab muscle/fat model "nnUNetTrainer__nnUNetResEncUNetXLPlans__2d".
            cmd = ["nnUNetv2_predict_from_modelfolder", "-i", str(inp), "-o", str(outdir), "-m", folder,
                   "-f", *os.environ.get("NNUNET_FOLDS", "0").split(),
                   "-chk", os.environ.get("NNUNET_CHECKPOINT", "checkpoint_final.pth")]
        else:
            cmd = ["nnUNetv2_predict", "-i", str(inp), "-o", str(outdir),
                   "-d", os.environ["NNUNET_DATASET"], "-c", os.environ.get("NNUNET_CONFIG", "3d_fullres")]
            if folds := os.environ.get("NNUNET_FOLDS"):
                cmd += ["-f", *folds.split()]
        if os.environ.get("NNUNET_DEVICE"):
            cmd += ["-device", os.environ["NNUNET_DEVICE"]]
        if os.environ.get("NNUNET_THREADS"):  # fewer worker processes = less memory
            cmd += ["-npp", os.environ["NNUNET_THREADS"], "-nps", os.environ["NNUNET_THREADS"]]
        if not tta:
            cmd += ["--disable_tta"]
        run.tta = tta
        run.log("INFO", "NNUNET", f"test-time augmentation (mirroring) {'ON' if tta else 'OFF'}")
        with run.stage("inference"):
            stream_cmd(run, cmd, "NNUNET")
        result = sorted(outdir.glob("case.nii*"))
        if not result:
            raise RuntimeError("nnU-Net produced no output file.")
        out = result[0]
        if crop:
            # put the slab back into a mask the size of the whole scan
            with run.stage("postprocess"):
                part = np.asanyarray(nib.load(str(out)).dataobj).astype(np.uint8)
                full = np.zeros(full_img.shape[:3], np.uint8)
                sl = [slice(None)] * 3
                sl[crop[0]] = slice(crop[1], crop[2])
                full[tuple(sl)] = part
                out = work / "tissue_full.nii.gz"
                img = nib.Nifti1Image(full, full_img.affine, full_img.header)
                img.set_data_dtype(np.uint8)
                img.header.set_slope_inter(1, 0)
                nib.save(img, str(out))
        labels = nnunet_labels(folder) if folder else None
        if AUTO_L3 and have_ts:
            try:
                if found is None:  # cropping off: detect after segmentation, as before
                    found = find_vertebrae(run, ct if ct.exists() else case, work)
                labels = {**(labels or {}), **merge_vertebrae(run, out, found)}
            except Exception as e:  # noqa: BLE001
                run.log("WARN", "VERTEBRAE", f"automatic vertebra detection failed, set L3 by hand: {str(e)[-200:]}")
        return out, labels

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
        return out, {1: "muscle_hu_range", 3: "fat_hu_range"}

    raise RuntimeError(f"Unknown MODEL '{MODEL}'. Use totalseg, nnunet or demo.")
