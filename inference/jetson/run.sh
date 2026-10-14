#!/usr/bin/env bash
# Build and start the segmentation server on a Jetson. Usage:  ./jetson/run.sh  [API_KEY]
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${1:-change-me}"
docker build -t bodycomp-seg -f jetson/Dockerfile .
docker rm -f bodycomp-seg 2>/dev/null || true
# tegrastats is mounted read-only so the Run log and Device status can show GPU load, memory, temperature and power.
# --shm-size: nnU-Net passes volumes between worker processes through shared memory (Docker default is 64 MB).
docker run -d --name bodycomp-seg --runtime nvidia --restart unless-stopped --shm-size 4g \
  -p 8000:8000 -e API_KEY="$KEY" \
  -v totalseg-data:/root/.totalsegmentator \
  -v /usr/bin/tegrastats:/usr/bin/tegrastats:ro \
  bodycomp-seg
echo "Started. Check:  curl http://localhost:8000/health"
echo "GPU check:       docker exec bodycomp-seg python3 -c \"import torch; print(torch.cuda.is_available())\""
