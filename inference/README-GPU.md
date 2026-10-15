# Setting up the GPU machine (TotalSegmentator)

> **NVIDIA Jetson (AGX Xavier, Orin) on JetPack 5?** Use the Docker setup in `jetson/README-JETSON.md` instead: JetPack 5 is limited to Python 3.8.

The GPU machine runs `server.py`. It does two jobs for the web app:

- **DICOM → NIfTI**: the app uploads a DICOM folder or .zip; the server picks the CT series with the most slices and converts it. Names, IDs and dates do not survive the conversion.
- **Segmentation**: TotalSegmentator `tissue_types` (subcutaneous fat, torso fat, skeletal muscle), plus `vertebrae_L3` so the app sets the L3 slice automatically.

## Using the Mazurowski-lab muscle/fat model instead of TotalSegmentator

On a normal GPU machine (Python 3.9+), install `nnunetv2>=2.5.1` and `TotalSegmentator>=2.6` (for automatic L3), download the
model folder `nnUNetTrainer__nnUNetResEncUNetXLPlans__2d` from the
[repo's Google Drive link](https://github.com/mazurowski-lab/CT-Muscle-and-Fat-Segmentation), then:

```bash
MODEL=nnunet NNUNET_MODEL_FOLDER=/path/to/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d NNUNET_FOLDS=5 \
API_KEY=change-me $PY -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Labels 1 muscle, 2 SAT, 3 VAT, 4 intermuscular fat. Weights are CC BY-NC 4.0 (cite arXiv:2502.09779).

## 1. Install (once)

Install the server into the **same Python that already runs TotalSegmentator**. Find it first:

```bash
head -1 "$(which TotalSegmentator)"      # e.g. #!/home/you/miniconda3/envs/totalseg/bin/python
```

Use that path as `PY` (or activate that conda/venv environment), then:

```bash
PY=/home/you/miniconda3/envs/totalseg/bin/python    # ← the path printed above, without "#!"
cd inference
$PY -m pip install -r requirements.txt
```

TotalSegmentator `tissue_types` needs a licence key (free for academic use; request it on the TotalSegmentator GitHub page). Replace `ABC123` with your real key, without angle brackets:

```bash
totalseg_set_license -l ABC123
```

Model weights download on the first run, so that run needs internet access and takes longer.

## 2. Check TotalSegmentator by itself

```bash
TotalSegmentator -i some_ct.nii.gz -o test_tissue.nii.gz --task tissue_types --ml
TotalSegmentator -i some_ct.nii.gz -o test_l3.nii.gz --roi_subset vertebrae_L3 --ml
```

If the first command says the licence is missing, repeat `totalseg_set_license`.

## 3. Start the server

```bash
MODEL=totalseg API_KEY=change-me $PY -m uvicorn server:app --host 0.0.0.0 --port 8000
```

`$PY -m uvicorn` works even when the `uvicorn` command is not on your PATH.

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `TOTALSEG_TASK` | `tissue_types` | TotalSegmentator task for the tissue mask |
| `AUTO_L3` | `1` | Also find the L3 vertebra and set the L3 slice automatically |
| `TOTALSEG_FAST` | `0` | `1` = faster 3 mm models (less accurate; useful on small GPUs) |
| `API_KEY` | empty | Shared secret; set the same value as `INFERENCE_API_KEY` in the web app |

Check it from the web-app machine: `curl http://<gpu-machine-ip>:8000/health`

## 4. Point the web app at it

In the web app's `.env.local`:

```
INFERENCE_URL=http://<gpu-machine-ip>:8000/segment
INFERENCE_API_KEY=change-me
```

Restart the app. "DICOM folder…" / "DICOM .zip…" and "Run segmentation" become active, and the sidebar's Device status shows the GPU.

## Notes

- "Torso fat" from `tissue_types` is all fat inside the torso outside the subcutaneous layer, used here as the visceral-fat (VAT) measure. Say so when you report VAT.
- Always confirm the automatic L3 slice on the coronal or sagittal view before signing a report.
- If L3 detection fails (for example L3 is outside the scan), the tissue mask still loads and you set L3 by hand; the Run log says why.
