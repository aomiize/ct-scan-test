#!/usr/bin/env bash
# Install the segmentation server directly on a Jetson (JetPack 5.1, Python 3.8), without Docker.
# Needs about 4–5 GB instead of ~12 GB for the Docker image. Everything goes into one folder (a venv),
# so removing it later is just:  rm -rf ~/bodycomp-venv
#
# Usage (from the inference/ folder):   ./jetson/install-native.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VENV="${VENV:-$HOME/bodycomp-venv}"
# NVIDIA's GPU build of PyTorch for JetPack 5.1.x / Python 3.8 (from NVIDIA's "Installing PyTorch for Jetson" page)
TORCH_WHL="torch-2.0.0+nv23.05-cp38-cp38-linux_aarch64.whl"
TORCH_URLS=("https://developer.download.nvidia.com/compute/redist/jp/v511/pytorch/$TORCH_WHL"
            "https://developer.download.nvidia.cn/compute/redist/jp/v511/pytorch/$TORCH_WHL")

echo "== Free space before:"; df -h / | tail -1
sudo apt-get update -y
sudo apt-get install -y python3-pip python3-venv libopenblas-dev

python3 -m venv "$VENV"
# shellcheck disable=SC1091
. "$VENV/bin/activate"
python -m pip install --no-cache-dir --upgrade "pip<25.1" wheel

echo "== Installing NVIDIA PyTorch (GPU)"
ok=0
for u in "${TORCH_URLS[@]}"; do
  if python -m pip install --no-cache-dir "$u"; then ok=1; break; fi
done
[ "$ok" = 1 ] || { echo "Could not download $TORCH_WHL. Check internet access, then rerun."; exit 1; }

echo "== Installing pinned packages (Python 3.8 versions; --no-deps keeps NVIDIA's PyTorch)"
grep -vE '^\s*(#|$)' jetson/requirements-jetson.txt | sed 's/\s*#.*$//' > /tmp/bodycomp-req.txt
python -m pip install --no-cache-dir --no-deps -r /tmp/bodycomp-req.txt
python -m pip install --no-cache-dir --no-deps --ignore-requires-python "nnunetv2==2.1" "TotalSegmentator==2.0.5"
python jetson/patch_totalseg.py

echo "== Checks"
python -c "import torch; print('torch', torch.__version__, '| GPU available:', torch.cuda.is_available())"
python -c "import nnunetv2, totalsegmentator.nnunet, SimpleITK, fastapi; print('nnU-Net, TotalSegmentator, SimpleITK, FastAPI: OK')"
TotalSegmentator --version
echo "== Free space after:"; df -h / | tail -1

cat <<MSG

Installed in $VENV.
1) Licence (for tissue_types):   $VENV/bin/totalseg_set_license -l aca_YOURNUMBER
2) Start the server:
   cd $(pwd)
   MODEL=totalseg API_KEY=change-me TOTALSEG_THREADS=2 $VENV/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
MSG
