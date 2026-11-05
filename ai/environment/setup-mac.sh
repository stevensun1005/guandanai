#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Use native Apple silicon macOS (not Rosetta). This script does not install an Intel CPU fallback.' >&2
  exit 1
fi
command -v node >/dev/null || { echo 'Install Node.js 24 LTS first.' >&2; exit 1; }
node --input-type=module -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Use Node.js 24 LTS")'
command -v python3.12 >/dev/null || { echo 'Install native Python 3.12 first.' >&2; exit 1; }
xcode-select -p >/dev/null || { echo 'Run xcode-select --install, then retry.' >&2; exit 1; }
python3.12 -c 'import platform; assert platform.machine()=="arm64", "Use native arm64 Python"'
python3.12 -m venv ai/danMCai/environment/mac
mac_python=ai/danMCai/environment/mac/bin/python
"$mac_python" -m pip install -r ai/environment/requirements-training.txt
npm ci
PYTORCH_ENABLE_MPS_FALLBACK=0 "$mac_python" -c 'import torch; assert torch.backends.mps.is_available(), "Apple MPS is unavailable; do not start CPU training silently"; print(torch.ones(1,device="mps")); print("torch",torch.__version__)'
"$mac_python" -m pip freeze > ai/danMCai/environment/mac-installed.txt
echo 'Environment prepared. Read ai/research/MAC_HANDOFF.md before importing and starting the 24h window.'
