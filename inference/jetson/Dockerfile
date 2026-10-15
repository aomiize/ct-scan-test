# BodyComp segmentation server for NVIDIA Jetson (JetPack 5 / L4T R35, e.g. AGX Xavier).
#
# JetPack 5 only has GPU PyTorch for Python 3.8, and TotalSegmentator v2 officially asks for 3.9.
# Their code needs only a few type-hint fixes (patch_py38.py), so we install pinned Python 3.8 dependencies and then
# nnU-Net 2.5.1 + TotalSegmentator 2.6 without their Python-version check. Runs TotalSegmentator and nnU-Net model folders.
#
# Build (from the inference/ folder):   docker build -t bodycomp-seg -f jetson/Dockerfile .
FROM dustynv/pytorch:2.1-r35.4.1

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive

COPY jetson/requirements-jetson.txt jetson/patch_py38.py /tmp/
# --no-deps: install exactly the pinned list and never touch the container's CUDA PyTorch.
# patch_py38.py: Python 3.8 type-hint fixes + TotalSegmentator version lookup without preview-only dependencies.
RUN grep -vE '^\s*(#|$)' /tmp/requirements-jetson.txt | sed 's/\s*#.*$//' > /tmp/req.txt \
 && python3 -m pip install --no-deps -r /tmp/req.txt \
 && python3 -m pip install --no-deps --ignore-requires-python "batchgeneratorsv2==0.2.1" "nnunetv2==2.5.1" "TotalSegmentator==2.6.0" \
 && python3 /tmp/patch_py38.py \
 && python3 -c "import torch, nnunetv2, totalsegmentator.nnunet, SimpleITK, fastapi; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" \
 && TotalSegmentator --version

WORKDIR /app
COPY server.py /app/server.py

# Model weights and the licence are stored here; mount a volume so they survive restarts.
VOLUME /root/.totalsegmentator
ENV MODEL=totalseg TOTALSEG_TASK=tissue_types AUTO_L3=1 TOTALSEG_FAST=0 TOTALSEG_THREADS=2 API_KEY=""
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
