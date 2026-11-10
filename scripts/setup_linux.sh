#!/usr/bin/env bash
# Install local runtime dependencies. Does not remaster a video and does not
# download weights when models/realesr-general-x4v3.onnx is already present.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.11 or newer is required." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20 or newer (with npm) is required for the local ONNX Runtime Web assets." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg and ffprobe are not on PATH. Install a build with libsvtav1 first." >&2
  echo "See README.md, section 'FFmpeg with libsvtav1'. pip will not install FFmpeg." >&2
  exit 1
fi

python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e . --no-deps
if [[ ! -d node_modules/onnxruntime-web/dist ]]; then
  npm ci
fi
python -m remaster --check-deps
echo
echo "Dependencies are local. Next, with the venv still active:"
echo "  python -m remaster --check --backend wasm"
echo "  python -m remaster --input INPUT.mp4 --output OUTPUT.mkv --scale 2 --backend webgpu"
echo "Weight re-export (only if you do not have models/realesr-general-x4v3.onnx):"
echo "  python -m pip install -r requirements-bootstrap.txt --extra-index-url https://download.pytorch.org/whl/cpu"
echo "  python scripts/bootstrap_model.py"
