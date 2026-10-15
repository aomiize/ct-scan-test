# Segmentation server on a Jetson AGX Xavier (JetPack 5)

Two ways to install. Both give the same server.

| | Disk needed | Notes |
|---|---|---|
| **A. Native (recommended on 32 GB eMMC)** | ~4–5 GB + model weights | `./jetson/install-native.sh`. Everything in `~/bodycomp-venv`; GPU stats via tegrastats work directly. |
| **B. Docker** | ~12 GB | `./jetson/run.sh`. Fully isolated, but the base image alone is 5.4 GB. |

## A. Native install (no Docker)

```bash
cd inference
chmod +x jetson/install-native.sh
./jetson/install-native.sh
~/bodycomp-venv/bin/totalseg_set_license -l aca_YOURNUMBER
MODEL=totalseg API_KEY=change-me TOTALSEG_THREADS=2 ~/bodycomp-venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

The script prints `GPU available: True` at the end if PyTorch sees the Xavier's GPU. It installs nnU-Net 2.5.1 and
TotalSegmentator 2.6 (with small Python 3.8 fixes from `patch_py38.py`), so it can run either model below.

### Model option 1: Mazurowski-lab muscle/fat model (recommended, no licence)

[CT-Muscle-and-Fat-Segmentation](https://github.com/mazurowski-lab/CT-Muscle-and-Fat-Segmentation): nnU-Net v2, 2D ResEnc-XL.
Labels **1 skeletal muscle, 2 subcutaneous fat, 3 visceral fat, 4 intermuscular fat**, which are the app's generic labels.
It has real VAT, not the "torso fat" proxy of TotalSegmentator.

1. From the repo's Google Drive folder, download the folder **`nnUNetTrainer__nnUNetResEncUNetXLPlans__2d`**. It must contain
   `plans.json`, `dataset.json` and `fold_5/checkpoint_final.pth` (the repo uses fold 5).
2. Copy it to the Xavier, e.g. `~/models/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d/`.
3. Start the server:

```bash
cd inference
MODEL=nnunet \
NNUNET_MODEL_FOLDER=$HOME/models/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d \
NNUNET_FOLDS=5 NNUNET_CHECKPOINT=checkpoint_final.pth \
AUTO_L3=1 TOTALSEG_FAST=1 API_KEY=change-me \
~/bodycomp-venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

`AUTO_L3=1` runs TotalSegmentator's free `vertebrae_L3` model after the tissue model, so the app sets the L3 slice itself.
If memory runs short, add `NNUNET_THREADS=1 TOTALSEG_THREADS=1`.

Licence: the weights are **CC BY-NC 4.0** (non-commercial; credit required). Cite: Chen Y, et al. *Automated Muscle and Fat
Segmentation in Computed Tomography for Comprehensive Body Composition Analysis.* arXiv:2502.09779 (2025).

### Model option 2: TotalSegmentator tissue_types (needs a free academic licence)

```bash
~/bodycomp-venv/bin/totalseg_set_license -l aca_YOURNUMBER
MODEL=totalseg API_KEY=change-me TOTALSEG_THREADS=2 ~/bodycomp-venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

TotalSegmentator weights (~1–2 GB) download on the first run into `~/.totalsegmentator`.

## B. Docker

Everything runs in Docker, so nothing changes in the Jetson's own Python 3.8.

### 1. Build and start (once, about 20–40 minutes the first time)

```bash
cd inference
./jetson/run.sh change-me          # change-me = the API key the web app will send
```

Check it:

```bash
curl http://localhost:8000/health
docker exec bodycomp-seg python3 -c "import torch; print(torch.cuda.is_available())"   # must print True
```

### 2. TotalSegmentator licence (for tissue_types)

Request the free academic licence on the TotalSegmentator GitHub page, then (replace ABC123 with your key, no angle brackets):

```bash
docker exec bodycomp-seg totalseg_set_license -l ABC123
```

The licence and the model weights are kept in the `totalseg-data` Docker volume, so this is done once.

### 3. First test inside the container

Copy one CT in and run TotalSegmentator directly. The first run downloads the weights (needs internet):

```bash
docker cp some_ct.nii.gz bodycomp-seg:/tmp/ct.nii.gz
docker exec bodycomp-seg TotalSegmentator -i /tmp/ct.nii.gz -o /tmp/tissue.nii.gz --task tissue_types --ml
docker exec bodycomp-seg TotalSegmentator -i /tmp/ct.nii.gz -o /tmp/l3.nii.gz --roi_subset vertebrae_L3 --ml
```

If it is too slow or runs out of memory (`docker logs` shows the process was killed), add to the `docker run` line in `run.sh`:
`-e TOTALSEG_FAST=1` (3 mm models, much faster and lighter) and/or `-e TOTALSEG_THREADS=1` (fewer worker processes), then run `./jetson/run.sh` again.

Tested on Python 3.8 (torch 2.1) from these exact pins: TotalSegmentator 2.6 found L3 on a 512×512×53 CT (27 s on a
2-core CPU, `--fast`), and the server's `MODEL=nnunet` model-folder path ran inference, read label names from
`dataset.json` and merged the automatic L3. Not yet run on Jetson hardware itself.

## 4. Connect the web app

In the web app's `.env.local`:

```
INFERENCE_URL=http://<jetson-ip>:8000/segment
INFERENCE_API_KEY=change-me
```

## Troubleshooting

- **Logs:** `docker logs -f bodycomp-seg` (the app's Run log tab shows the same lines per run).
- **Weights download fails** (old download links): download them on any PC with a newer TotalSegmentator, copy the
  `~/.totalsegmentator/nnunet/results` folder over, and run `docker cp` into the container at the same path,
  or use `totalseg_import_weights`.
- **Device status shows no GPU numbers:** the `tegrastats` mount is missing; check the `-v /usr/bin/tegrastats` line.
- **Run hangs with no CPU use:** a worker process was killed for memory and the main process waits forever. Use `TOTALSEG_THREADS=1` and check `free -h`.
- **Why these versions:** JetPack 5 only has GPU PyTorch for Python 3.8. nnU-Net 2.5.1 (needed for the ResEnc models) and
  TotalSegmentator 2.6 declare Python 3.9+, but their code needs only the small type-hint fixes in `patch_py38.py`.
