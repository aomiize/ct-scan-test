#!/usr/bin/env bash
# Install the segmentation server directly on a Jetson (JetPack 5.1, Python 3.8), without Docker.
# Needs about 4–5 GB instead of ~12 GB for the Docker image. Everything goes into one folder (a venv),
# so removing it later is just:  rm -rf ~/bodycomp-venv
#
# Usage (from the inference/ folder):   ./jetson/install-native.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VENV="${VENV:-$HOME/bodycomp-venv}"
# NVIDIA's GPU builds of PyTorch for Python 3.8: 2.1 for JetPack 5.1.2+ (preferred), 2.0 for JetPack 5.1.1 as fallback.
TORCH_URLS=("https://developer.download.nvidia.com/compute/redist/jp/v512/pytorch/torch-2.1.0a0+41361538.nv23.06-cp38-cp38-linux_aarch64.whl"
            "https://developer.download.nvidia.com/compute/redist/jp/v511/pytorch/torch-2.0.0+nv23.05-cp38-cp38-linux_aarch64.whl"
            "https://developer.download.nvidia.cn/compute/redist/jp/v511/pytorch/torch-2.0.0+nv23.05-cp38-cp38-linux_aarch64.whl")

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
[ "$ok" = 1 ] || { echo "Could not download NVIDIA's PyTorch wheel. Check internet access, then rerun."; exit 1; }

echo "== Installing pinned packages (Python 3.8 versions; --no-deps keeps NVIDIA's PyTorch)"
grep -vE '^\s*(#|$)' jetson/requirements-jetson.txt | sed 's/\s*#.*$//' > /tmp/bodycomp-req.txt
python -m pip install --no-cache-dir --no-deps -r /tmp/bodycomp-req.txt
python -m pip install --no-cache-dir --no-deps --ignore-requires-python \
  "batchgeneratorsv2==0.2.1" "nnunetv2==2.5.1" "TotalSegmentator==2.6.0"
python jetson/patch_py38.py

echo "== Checks"
python -c "import torch; print('torch', torch.__version__, '| GPU available:', torch.cuda.is_available())"
python -c "from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor; from nnunetv2.training.nnUNetTrainer.nnUNetTrainer import nnUNetTrainer; import totalsegmentator.nnunet, SimpleITK, fastapi; print('nnU-Net 2.5.1, TotalSegmentator 2.6, SimpleITK, FastAPI: OK')"
TotalSegmentator --version
echo "== Free space after:"; df -h / | tail -1

cat <<MSG

Installed in $VENV.
Start the server with ONE of these (from $(pwd)):

 A) Mazurowski-lab muscle/fat model (no licence needed; see jetson/README-JETSON.md for the weights):
   MODEL=nnunet NNUNET_MODEL_FOLDER=$HOME/models/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d NNUNET_FOLDS=5 \\
   API_KEY=change-me $VENV/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000

 B) TotalSegmentator tissue_types (licence: $VENV/bin/totalseg_set_license -l aca_YOURNUMBER):
   MODEL=totalseg API_KEY=change-me TOTALSEG_THREADS=2 $VENV/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
MSG
