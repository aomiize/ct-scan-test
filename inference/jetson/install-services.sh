#!/usr/bin/env bash
# Run the segmentation server and the web app as background services that keep running after the terminal or
# browser is closed and start again by themselves after a reboot or a crash.
#
# Run as your normal user (not with sudo); it asks for the sudo password when it installs the services:
#   bash inference/jetson/install-services.sh
#
# Optional settings (defaults in brackets):
#   VENV=~/bodycomp-venv  MODEL_FOLDER=~/models/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d  FOLD=5
#   API_KEY=change-me  AUTO_L3=1  WEB_PORT=3000
# Example:  AUTO_L3=0 bash inference/jetson/install-services.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${VENV:-$HOME/bodycomp-venv}"
MODEL_FOLDER="${MODEL_FOLDER:-$HOME/models/nnUNetTrainer__nnUNetResEncUNetXLPlans__2d}"
FOLD="${FOLD:-5}"
API_KEY="${API_KEY:-change-me}"
AUTO_L3="${AUTO_L3:-1}"
WEB_PORT="${WEB_PORT:-3000}"
RUN_USER="$(id -un)"

[ "$(id -u)" = 0 ] && { echo "Run this as your normal user, not with sudo."; exit 1; }
[ -x "$VENV/bin/python" ] || { echo "No Python at $VENV/bin/python. Set VENV=… to your environment."; exit 1; }
[ -f "$MODEL_FOLDER/dataset.json" ] || { echo "No dataset.json in $MODEL_FOLDER. Check the folder name (it has double underscores)."; exit 1; }
"$VENV/bin/python" -c "import uvicorn" 2>/dev/null || { echo "uvicorn is not installed in $VENV. Run: $VENV/bin/pip install uvicorn fastapi"; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js is not installed. See README-JETSON.md (Node 20)."; exit 1; }

echo "Project:      $REPO"
echo "Python:       $VENV/bin/python"
echo "Model folder: $MODEL_FOLDER (fold $FOLD)"
echo "Node:         $NODE ($("$NODE" -v))"

# Web app settings: the app on the same machine reaches the server at localhost.
cd "$REPO"
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Created .env.local from .env.example"
fi
sed -i "s#^INFERENCE_URL=.*#INFERENCE_URL=http://localhost:8000/segment#; s#^INFERENCE_API_KEY=.*#INFERENCE_API_KEY=$API_KEY#" .env.local

if [ ! -f .next/standalone/server.js ] || [ .env.local -nt .next/standalone/server.js ]; then
  echo "Building the web app (a few minutes)…"
  [ -d node_modules ] || npm install
  npm run build
fi

sudo tee /etc/systemd/system/bodycomp-seg.service >/dev/null <<EOF
[Unit]
Description=BodyComp segmentation server
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$REPO/inference
Environment=PATH=$VENV/bin:/usr/local/bin:/usr/bin:/bin
Environment=MODEL=nnunet
Environment=NNUNET_MODEL_FOLDER=$MODEL_FOLDER
Environment=NNUNET_FOLDS=$FOLD
Environment=NNUNET_CHECKPOINT=checkpoint_final.pth
Environment=AUTO_L3=$AUTO_L3
Environment=TOTALSEG_FAST=1
Environment=API_KEY=$API_KEY
ExecStart=$VENV/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/bodycomp-web.service >/dev/null <<EOF
[Unit]
Description=BodyComp web app
After=network-online.target bodycomp-seg.service
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$REPO
# Read settings (passwords, LLM) at start, so editing .env.local only needs a restart, not a rebuild.
EnvironmentFile=-$REPO/.env.local
Environment=HOSTNAME=0.0.0.0
Environment=PORT=$WEB_PORT
Environment=NODE_ENV=production
ExecStart=$NODE $REPO/.next/standalone/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now bodycomp-seg bodycomp-web
command -v ufw >/dev/null && sudo ufw status | grep -q active && sudo ufw allow "$WEB_PORT"/tcp >/dev/null || true

sleep 5
IP="$(hostname -I | awk '{print $1}')"
echo
systemctl --no-pager --lines=0 status bodycomp-seg bodycomp-web | grep -E "●|Active:" || true
echo
echo "Done. Open http://$IP:$WEB_PORT from any computer on the network (or http://localhost:$WEB_PORT here)."
echo "Both services start by themselves after a reboot."
echo "  Logs:     journalctl -u bodycomp-seg -f      journalctl -u bodycomp-web -f"
echo "  Restart:  sudo systemctl restart bodycomp-seg bodycomp-web"
echo "  Stop:     sudo systemctl stop bodycomp-seg bodycomp-web   (disable to stop autostart)"
