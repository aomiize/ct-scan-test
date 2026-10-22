"""
Rebuild an nnU-Net v2 model folder from checkpoint files alone.

nnU-Net v2 saves its plans and dataset description inside every checkpoint ("init_args"), so plans.json and
dataset.json can be recovered when only checkpoint_final.pth / checkpoint_best.pth were copied.

Usage:
    python rebuild_model_folder.py ~/backup_weights            # folder with checkpoint_*.pth
    python rebuild_model_folder.py ~/backup_weights --out ~/models

Creates  <out>/<Trainer>__<Plans>__<configuration>/{plans.json, dataset.json, fold_<n>/checkpoint_*.pth}
The checkpoints are linked, not copied, so no extra disk space is used. Prints the server start command.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="folder that contains checkpoint_final.pth and/or checkpoint_best.pth")
    ap.add_argument("--out", default=str(Path.home() / "models"), help="where to create the model folder (default ~/models)")
    ap.add_argument("--copy", action="store_true", help="copy checkpoints instead of linking them")
    args = ap.parse_args()

    src = Path(args.src).expanduser().resolve()
    ckpts = [p for p in (src / "checkpoint_final.pth", src / "checkpoint_best.pth") if p.exists()]
    if not ckpts:
        print(f"No checkpoint_final.pth or checkpoint_best.pth in {src}")
        return 1

    import torch

    print(f"Reading {ckpts[0].name} (this can take a minute for large models)…")
    try:
        ck = torch.load(str(ckpts[0]), map_location="cpu", weights_only=False)
    except TypeError:  # very old torch without weights_only
        ck = torch.load(str(ckpts[0]), map_location="cpu")

    init = ck.get("init_args") if isinstance(ck, dict) else None
    if not init or "plans" not in init or "dataset_json" not in init:
        keys = list(ck.keys()) if isinstance(ck, dict) else type(ck).__name__
        print("This checkpoint does not contain nnU-Net v2 'init_args' with plans and dataset_json.")
        print(f"Keys found: {keys}")
        print("You need the original plans.json and dataset.json from the folder the model was trained in.")
        return 2

    plans, dataset_json = init["plans"], init["dataset_json"]
    configuration = init.get("configuration", "3d_fullres")
    fold = init.get("fold", 0)
    trainer = ck.get("trainer_name", "nnUNetTrainer")
    plans_name = plans.get("plans_name", "nnUNetPlans")

    folder = Path(args.out).expanduser().resolve() / f"{trainer}__{plans_name}__{configuration}"
    fold_dir = folder / f"fold_{fold}"
    fold_dir.mkdir(parents=True, exist_ok=True)
    (folder / "plans.json").write_text(json.dumps(plans, indent=2))
    (folder / "dataset.json").write_text(json.dumps(dataset_json, indent=2))

    for c in ckpts:
        dst = fold_dir / c.name
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        if args.copy:
            import shutil
            shutil.copy2(c, dst)
        else:
            try:
                os.link(c, dst)  # hard link: same file, no extra space
            except OSError:
                dst.symlink_to(c)

    labels = dataset_json.get("labels", {})
    print()
    print(f"Model folder: {folder}")
    print(f"  trainer {trainer} · plans {plans_name} · configuration {configuration} · fold {fold}")
    print(f"  labels: {labels}")
    print(f"  checkpoints: {', '.join(c.name for c in ckpts)}")
    chk = "checkpoint_final.pth" if any(c.name == "checkpoint_final.pth" for c in ckpts) else ckpts[0].name
    here = Path(__file__).resolve().parent
    print()
    print("Start the server with:")
    print(f'cd "{here}" && MODEL=nnunet NNUNET_MODEL_FOLDER="{folder}" NNUNET_FOLDS={fold} '
          f"NNUNET_CHECKPOINT={chk} AUTO_L3=1 TOTALSEG_FAST=1 API_KEY=change-me "
          f"{sys.executable} -m uvicorn server:app --host 0.0.0.0 --port 8000")
    return 0


if __name__ == "__main__":
    sys.exit(main())
