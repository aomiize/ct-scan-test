# BodyComp: CT body composition workstation (Next.js)

L3 body-composition analysis for abdominal CT, built to run on a hospital intranet.

| Tab | What it does |
|---|---|
| **Overview** | Muscle, visceral-fat and total-adipose volumes over the segmented range; L3 muscle attenuation; live axial view; 3D surface model of the mask; tissue composition; L3 indices against reference cut-offs; PDF and CSV export |
| **Slice viewer** | Synced axial / coronal / sagittal MPR with crosshair, W/L presets, HU probe, zoom/pan, mm caliper |
| **Metrics table** | Per-label voxels, volume, mean and SD HU, slice and L3 areas; cross-sectional area by slice (click to navigate); CSV |
| **AI report** | Draft narrative from an OpenAI-compatible LLM (e.g. MedGemma on vLLM) or a rule-based fallback; flags numbers in the draft that don't match any measurement; editable text; physician sign-off with Ed25519 signature stored on the server; print / save as PDF |
| **Transmitted JSON** | The exact de-identified payload, LLM request and raw response, and the signature receipt |
| **Run log** | Server pipeline log (stages, model output) merged with the browser session log; level filter; export; wall time, peak memory, throughput; memory / GPU / power profile |

The sidebar also has a server **case library**, the **report endpoint** status and live **device status** (GPU memory, utilisation, temperature, power).

> Research and decision-support use only. Not a cleared medical device. A qualified reader must verify the segmentation and the L3 level, and review any generated text, before clinical use.

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in what you have; everything is optional
npm run dev                     # http://localhost:3000
```

The page opens on a synthetic phantom (clearly labelled, cannot be signed), so every tab works without patient data or servers.

## Services

```
browser ──► Next.js (this app) ──► inference/server.py  (segmentation, run logs, device status)
                               ├─► OpenAI-compatible LLM (draft reports; de-identified numbers only)
                               └─► DATA_DIR             (signed reports, signing key)   CASES_DIR (case library)
```

### Segmentation server (GPU machine)

Step-by-step setup: **`inference/README-GPU.md`** (normal GPU machine) or **`inference/jetson/README-JETSON.md`** (Jetson, JetPack 5).
Supported models: the Mazurowski-lab muscle/fat nnU-Net (muscle, SAT, VAT, intermuscular fat; no licence), TotalSegmentator
`tissue_types` (licence), or any nnU-Net v2 model folder; label names are read from its `dataset.json`. The server also converts DICOM (folder or .zip) to NIfTI without patient metadata, and finds the L3 vertebra so the L3 slice is set automatically.


```bash
cd inference
pip install -r requirements.txt
MODEL=demo     API_KEY=change-me uvicorn server:app --host 0.0.0.0 --port 8000   # HU thresholds, pipeline test only
MODEL=totalseg API_KEY=change-me uvicorn server:app --host 0.0.0.0 --port 8000   # TotalSegmentator tissue_types (licence required)
MODEL=nnunet NNUNET_DATASET=501 LABEL_SCHEME=generic API_KEY=change-me uvicorn server:app --host 0.0.0.0 --port 8000
```

It streams model output into the run log and samples resources every 0.5 s with `tegrastats` (Jetson), `nvidia-smi`, or `psutil` as a fallback.

| Scheme | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `generic` | skeletal muscle | SAT | VAT | IMAT | bone |
| `totalseg` | SAT | torso fat (→ VAT) | skeletal muscle | | |

### Language model

Any OpenAI-compatible `/v1/chat/completions` endpoint. For example, on a GPU server:

```bash
vllm serve google/medgemma-27b-text-it --port 8001
```

Then set `LLM_URL=http://<host>:8001/v1` and `LLM_MODEL=google/medgemma-27b-text-it`. The included `.env.local` points at the class server (`google/medgemma-1.5-4b-it`).

Small models are handled defensively: the app asks for JSON mode (`response_format`, dropped automatically if the server rejects it), repairs common JSON slips such as code fences or trailing commas, retries once when the reply can't be read, and if the model still fails or can't be reached, writes the rule-based draft and shows why. Only eight numbers are sent: `muscle_volume_mm3`, `muscle_density_hu`, `sfat_volume_mm3`, `vfat_volume_mm3`, `mfat_volume_mm3`, `total_fat_volume_mm3`, `body_volume_mm3`, `body_height_mm`, measured over T12–L4 (`lib/edge.ts`, `lib/edge-build.ts`). The browser checks the payload against this whitelist before sending, and `/api/report` checks it again and refuses (HTTP 422) any other field, any non-numeric value or anything over 1 KB, so no name, ID, date or DICOM tag can reach the model. Derived indices (VAT/SAT ratio, myosteatosis indication, mean muscle cross-section) are computed from the eight values at the prompt stage. The richer L3 metrics stay on the device for the viewer, the rule-based draft and the signed record. The server lists any number in the reply that is not in the prompt, and the UI warns before signing.

### Signing

Signing stores `DATA_DIR/reports/<case>_<time>.json` with the metrics, narrative, model provenance, reader name, the SSO user from the reverse proxy (`X-Forwarded-User` / `Remote-User`) and remarks, signed with Ed25519. Verify a file:

```bash
node scripts/verify-report.mjs data/reports/<file>.json            # on the server
node scripts/verify-report.mjs <file>.json public-key.pem          # elsewhere; key from GET /api/sign
```

The typed reader name is not authentication. Put the app behind your SSO reverse proxy so the login is recorded too.

### Reference cut-offs

`lib/reference.ts` holds every threshold with its citation: SMI and muscle attenuation (Martin 2013), visceral fat area (Doyle 2013, measured at L3–L4). The VAT/SAT ratio and volumetric values have no reference set. Replace these with values validated for your population.

## DICOM

DICOM folders and .zip files are converted to NIfTI in the browser (`lib/dicom.ts`, result identical to SimpleITK on
the test study), so the DICOM headers with patient details never leave the user's computer and no server is needed.
The largest CT series is used; scouts/localizers are skipped. Compressed studies (JPEG, JPEG 2000, RLE) are sent to
the inference server's `/convert` instead, if `INFERENCE_URL` is set.

## Sign-in

Set `APP_PASSWORD` (one shared password) or `APP_USERS=mon:pass1,prof:pass2` (named accounts) in `.env.local` and restart. Every page and API then requires signing in; the session is a signed, HTTP-only cookie (12 h by default, `SESSION_HOURS`). Five wrong passwords from one address lock it out for 15 minutes. The signed-in name is written to the audit log and into signed reports. With neither variable set there is no login.

## Production

```bash
npm run build && npm start                     # standalone server; PORT, HOSTNAME env vars
docker build -t bodycomp . && docker run -p 3000:3000 -v bodycomp-data:/data --env-file .env.local bodycomp
```

All API routes write one JSON audit line per action to stdout (case open, segmentation, report request, signature).

## Not included

- PACS query/retrieve (DICOM folder and .zip upload are supported) and DICOM SR export.
- Built-in login and roles: use the hospital SSO proxy.
- A database: signed reports are JSON files in `DATA_DIR`.
- Local validation of the segmentation model, the LLM prompt and the cut-offs.

## Layout

```
app/api/        segment, runs/[id], device, report, sign, cases, cases/[name]
components/     Workstation, Sidebar, Overview, Viewport, Mesh3D, MetricsTable, AIReport, TransmittedJson, RunLog, Charts
lib/            nifti, views, render, labels, metrics, volumetrics, reference, payload, csv, session-log, server/*
inference/      server.py (FastAPI segmentation server)
scripts/        copy-static.mjs, verify-report.mjs
```
