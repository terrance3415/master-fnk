# Install local runtime dependencies. Does not remaster a video.
# Run from a normal PowerShell prompt:  powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Require-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "$name is not on PATH."
    }
}

Require-Command python
Require-Command node
Require-Command npm
Require-Command ffmpeg
Require-Command ffprobe

python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m pip install -e . --no-deps
if (-not (Test-Path "node_modules\onnxruntime-web\dist")) {
    npm ci
}
.\.venv\Scripts\python -m remaster --check-deps
Write-Host ""
Write-Host "Dependencies are local. Next:"
Write-Host "  .\.venv\Scripts\python -m remaster --check --backend wasm"
Write-Host "  .\.venv\Scripts\python -m remaster --input INPUT.mp4 --output OUTPUT.mkv --scale 2 --backend webgpu"
Write-Host "If ffmpeg -encoders does not list libsvtav1, install a GPL FFmpeg build that links SVT-AV1."
Write-Host "See README.md. pip does not install FFmpeg."
