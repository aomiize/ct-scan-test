# BodyComp segmentation server for NVIDIA Jetson (JetPack 5 / L4T R35, e.g. AGX Xavier).
#
# JetPack 5 only has GPU PyTorch for Python 3.8, and TotalSegmentator v2 officially asks for 3.9.
# Its code (and nnU-Net 2.1's) contains nothing that needs 3.9, so we install the pinned dependencies for 3.8
# and then TotalSegmentator 2.0.5 + nnU-Net 2.1 without their Python-version check.
#
# Build (from the inference/ folder):   docker build -t bodycomp-seg -f jetson/Dockerfile .
FROM dustynv/pytorch:2.1-r35.4.1

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive

COPY jetson/requirements-jetson.txt jetson/patch_totalseg.py /tmp/
# --no-deps: install exactly the pinned list and never touch the container's CUDA PyTorch.
# The patch makes TotalSegmentator read its version without checking preview-only dependencies.
RUN python3 -m pip install --no-deps -r /tmp/requirements-jetson.txt \
 && python3 -m pip install --no-deps --ignore-requires-python "nnunetv2==2.1" "TotalSegmentator==2.0.5" \
 && python3 /tmp/patch_totalseg.py \
 && python3 -c "import torch, nnunetv2, totalsegmentator.nnunet, SimpleITK, fastapi; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" \
 && TotalSegmentator --version

WORKDIR /app
COPY server.py /app/server.py

# Model weights and the licence are stored here; mount a volume so they survive restarts.
VOLUME /root/.totalsegmentator
ENV MODEL=totalseg TOTALSEG_TASK=tissue_types AUTO_L3=1 TOTALSEG_FAST=0 TOTALSEG_THREADS=2 API_KEY=""
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
