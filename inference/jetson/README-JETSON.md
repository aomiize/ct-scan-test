# Segmentation server on a Jetson AGX Xavier (JetPack 5)

Everything runs in Docker, so nothing changes in the Jetson's own Python 3.8.

## 1. Build and start (once, about 20–40 minutes the first time)

```bash
cd inference
./jetson/run.sh change-me          # change-me = the API key the web app will send
```

Check it:

```bash
curl http://localhost:8000/health
docker exec bodycomp-seg python3 -c "import torch; print(torch.cuda.is_available())"   # must print True
```

## 2. TotalSegmentator licence (for tissue_types)

Request the free academic licence on the TotalSegmentator GitHub page, then (replace ABC123 with your key, no angle brackets):

```bash
docker exec bodycomp-seg totalseg_set_license -l ABC123
```

The licence and the model weights are kept in the `totalseg-data` Docker volume, so this is done once.

## 3. First test inside the container

Copy one CT in and run TotalSegmentator directly. The first run downloads the weights (needs internet):

```bash
docker cp some_ct.nii.gz bodycomp-seg:/tmp/ct.nii.gz
docker exec bodycomp-seg TotalSegmentator -i /tmp/ct.nii.gz -o /tmp/tissue.nii.gz --task tissue_types --ml
docker exec bodycomp-seg TotalSegmentator -i /tmp/ct.nii.gz -o /tmp/l3.nii.gz --roi_subset vertebrae_L3 --ml
```

If it is too slow or runs out of memory (`docker logs` shows the process was killed), add to the `docker run` line in `run.sh`:
`-e TOTALSEG_FAST=1` (3 mm models, much faster and lighter) and/or `-e TOTALSEG_THREADS=1` (fewer worker processes), then run `./jetson/run.sh` again.

Tested: TotalSegmentator 2.0.5 + nnU-Net 2.1 installed from these exact pins on Python 3.8 run correctly
(vertebrae_L3 on a 512×512×53 CT took 27 s on a 2-core CPU with `--fast`).

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
- **Why TotalSegmentator 2.0.5:** it is the newest release whose code runs on Python 3.8, and it includes
  `tissue_types` (subcutaneous fat, torso fat, skeletal muscle) and `vertebrae_L3`, with the same label numbers the app expects.
