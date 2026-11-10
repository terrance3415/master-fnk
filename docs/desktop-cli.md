# Desktop command line (optional)

You do not need this to use Master FNK. The phone app is the one to install. These notes are the original local command-line remaster, kept so the same checks still run on a computer. Windows and an RTX 3060 were not tested. See `TEST_REPORT.md`.

# Terrance video remaster

Local command-line remaster for your own videos. FFmpeg decodes the file, a Chrome page on `127.0.0.1` runs the official compact Real-ESRGAN model (`realesr-general-x4v3`, SRVGGNetCompact) in ONNX Runtime Web, a BasicVSR-style stabilizer reduces flicker, and FFmpeg `libsvtav1` writes AV1. There is no UI.

No content moderation or cloud uploads; files stay local; technical input validation only; setup may download public dependencies/weights; processing offline thereafter.

The tool does not classify, block, or upload frames. Rejection is technical only: unreadable file, missing video stream, HDR or more than 8-bit, variable frame rate, a start offset larger than one frame, frame size outside the configured pixel cap, a path that already exists, or a missing local encoder/model/browser. Malformed or unsupported files still fail. That is not a promise that every container works.

## Shortest commands

Python 3.11+ and Node.js 20+ (Node 22 is fine). Google Chrome 113 or newer. FFmpeg and ffprobe with `libsvtav1` linked in. `pip` does not install FFmpeg.

Linux, from this directory:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
python -m remaster --check --backend wasm
python -m remaster --input "INPUT.mp4" --output "OUTPUT.mkv" --scale 2 --backend webgpu
```

Windows PowerShell, from this directory, after FFmpeg's `bin` is on PATH:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
npm ci
.\.venv\Scripts\python -m remaster --check --backend wasm
.\.venv\Scripts\python -m remaster --input "INPUT.mp4" --output "OUTPUT.mkv" --scale 2 --backend webgpu
```

`scripts/setup_linux.sh` and `scripts/setup_windows.ps1` do the venv, pip, npm, and `--check-deps` steps. They do not render a video.

`--backend webgpu` is the default and the one to use on an RTX 3060. If Chrome cannot create a GPU adapter, the process exits with an error. It does not switch to WASM unless you pass `--backend wasm`.

## Pipeline order

1. Technical probe with ffprobe. Constant frame rate, 8-bit SDR, readable paths, output does not already exist.
2. Denoise, unless `--denoise 0` or `--denoise off`. Spatial bilateral filter, then a short motion-compensated blend of the denoised frames. This runs on the source frames, before the network, so compression noise is less likely to be rebuilt as texture.
3. Compact Real-ESRGAN in ONNX Runtime Web (`--backend webgpu` or explicit `--backend wasm`). The shipped network is the official x4 SRVGGNetCompact. Tiles run one at a time with overlap. For `--scale 2` each tile is inferred at 4x and box-downsampled 2x2 before the stitch, so a 1080p frame becomes 3840x2160 and a full 8K frame is not stored. For `--scale 4` the x4 result is kept.
4. Additional unsharp mask when `--sharpen` is above 0. `--sharpen 0` and `--sharpen off` skip this stage. They do not remove the sharpening the compact model already learned.
5. BasicVSR-style temporal stabilization. Optical flow warps the previous enhanced frame onto the current one. Forward-backward consistency and a photometric residual cut the mix on occlusions. A scene cut resets the recurrent state. The mix cap is `0.55 * --temporal-strength`, so the current frame keeps a majority of the weight. This is a functional baseline. It is not a trained BasicVSR checkpoint, and there is no BasicVSR weight file in this project.
6. Software AV1. Default is FFmpeg `libsvtav1` with `--preset 8` and `--crf 32`. Thread cap is the SVT option `lp`, passed as `-svtav1-params lp=N`. Optional `--encoder libaom-av1` is the only alternative. There is no H.264 or HEVC fallback. After the encode, ffprobe must report `codec_name=av1` or the output is deleted and the process exits nonzero.

Source FPS is reused as a rational (`30000/1001` stays `30000/1001`). Frame count is checked after the encode. Audio is stream-copied when the container can hold it (AAC into MKV or MP4 is the common case) and trimmed to the same duration. If copy is impossible, audio is transcoded to AAC for MP4 or Opus for MKV/WebM. Variable frame rate is rejected. A video or audio start time larger than one frame is rejected. Both of those would drift sync if the tool guessed.

## Source-type guidance

Neural upscaling cannot recover detail that was never in the pixels. A higher denoise, sharpen, or scale is not more true. The compact model already enhances edges. The extra unsharp is a separate, optional stage. Defaults are mild denoise (`low`, 0.25) and extra sharpen off, because a noisy source is the case that most often turns into invented texture, and extra sharpening on top of the model rings.

Named amounts: `off` = 0, `low` = 0.25, `medium` = 0.5, `high` = 0.75. Any number from 0 to 1 is also accepted. `high` is deliberately below 1. Values outside 0..1 are an error.

Soft or blurry:

```bash
python -m remaster --input "soft.mp4" --output "soft.mkv" --denoise off --sharpen low --temporal-strength 0.35 --backend webgpu
```

Turn denoise off so the bilateral filter does not blur the source further before the network. `--sharpen low` is a small extra unsharp. `--sharpen high` adds more halo. It does not restore a sharper original.

Noisy:

```bash
python -m remaster --input "noisy.mp4" --output "noisy.mkv" --denoise medium --sharpen off --temporal-strength 0.40 --backend webgpu
```

Denoise before the network. Leave the extra unsharp off so residual noise is not edged again.

Heavily compressed:

```bash
python -m remaster --input "compressed.mp4" --output "compressed.mkv" --denoise medium --sharpen low --temporal-strength 0.45 --scene-threshold 0.30 --backend webgpu
```

The denoise stage is first so block edges are weaker before SRVGGNetCompact runs. A slightly higher temporal strength calms flicker. This does not reconstruct the pre-compression picture.

Already sharp:

```bash
python -m remaster --input "sharp.mp4" --output "sharp.mkv" --denoise off --sharpen off --temporal-strength 0.25 --backend webgpu
```

Skip both extra stages. The compact model still runs. `--sharpen off` does not cancel that.

## What the model is

`models/realesr-general-x4v3.onnx` is an ONNX opset-17 export of the official Real-ESRGAN v0.2.5.0 file `realesr-general-x4v3.pth` (SHA-256 `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292`). Architecture: SRVGGNetCompact, 64 features, 32 body convolutions, x4, RGB. Channel-wise PReLU is exported as ReLU / Sub / Mul / Add with the same slopes, because ONNX Runtime WebGPU does not implement PReLU. The graph ops are Conv, Relu, Sub, Mul, Add, DepthToSpace, Resize. `models/manifest.json` records the hashes. `models/golden.npz` is a PyTorch reference used by `--check`.

The weights and architecture are BSD-3-Clause (Xintao Wang / Real-ESRGAN). See `models/LICENSE-Real-ESRGAN.txt`. The rest of this tool is MIT (`LICENSE`).

Runtime never downloads the model. If the ONNX file is missing or its hash does not match the manifest, the command tells you to export it:

```bash
python -m pip install -r requirements.txt
python -m pip install -r requirements-bootstrap.txt --extra-index-url https://download.pytorch.org/whl/cpu
python scripts/bootstrap_model.py
```

That is the only weight download. It fetches the official GitHub release asset, checks the SHA-256, and writes the ONNX next to the manifest. After that, remastering works with the network disconnected.

## FFmpeg with libsvtav1

Confirm the binary you will actually run:

```bash
ffmpeg -hide_banner -encoders | grep libsvtav1
ffprobe -version
```

Windows:

```powershell
ffmpeg -hide_banner -encoders | findstr libsvtav1
```

SVT-AV1 1.7 refuses an output width or height below 64. A 32x32 source with `--scale 2` is 64x64, which is the smallest output this tool will encode with libsvtav1. The list must contain `libsvtav1`. `libaom-av1` alone is only the optional slower encoder. An RTX 3060 has no hardware AV1 encoder. NVENC AV1, QSV, and VAAPI are not used. The encode is software SVT-AV1 on the CPU. Do not infer the CPU from the GPU. `--threads N` sets SVT `lp=N` (0 means `min(8, CPU count)`). Preflight encodes two black frames and requires the log line `Number of logical cores available` to match `min(N, CPU count)`. FFmpeg 6.1 can print an error for an unknown SVT key and still exit 0, so the log line is the check.

Ubuntu 24.04's `ffmpeg` package is built with `--enable-libsvtav1` (SVT-AV1 1.7 in the 24.04 package). If your build does not have it, link SVT yourself. A typical Linux build:

```bash
sudo apt-get install -y build-essential cmake git nasm pkg-config
git clone --depth 1 --branch v2.1.2 https://gitlab.com/AOMediaCodec/SVT-AV1.git
cmake -S SVT-AV1 -B SVT-AV1/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON
cmake --build SVT-AV1/build -j
sudo cmake --install SVT-AV1/build
sudo ldconfig
git clone --depth 1 --branch n7.1 https://github.com/FFmpeg/FFmpeg.git
cd FFmpeg
./configure --prefix=/usr/local --enable-gpl --enable-libsvtav1 --enable-libaom --enable-libopus
make -j
sudo make install
```

Windows: download a current GPL zip from the BtbN FFmpeg-Builds releases (asset name like `ffmpeg-master-latest-win64-gpl.zip`). Those builds link libsvtav1. Unzip it and add the `bin` directory to PATH. Open a new terminal and run the `findstr` check above.

`--encoder libaom-av1` maps `--preset` to libaom `-cpu-used` (0..8, higher is faster) and `--threads` to `-threads`, with `-row-mt 1` and `-b:v 0`. Those preset numbers are not comparable to SVT presets. libsvtav1 must still be present so the default path is installed; preflight checks it even when you ask for libaom.

## Browser worker

`worker/index.html` and `worker/infer.js` are served only on `127.0.0.1` by the Python process, together with `node_modules/onnxruntime-web/dist` and the ONNX file. There is no CDN fallback. `ort.env.wasm.wasmPaths` is set to that loopback `/ort/` directory before the session is created. Page requests whose host is not `127.0.0.1` or `localhost` are aborted. `--offline-probe` also aborts a deliberate fetch to example.com and records that the abort happened. Chrome is started with background networking, sync, and component updates disabled.

WebGPU needs a Chrome GPU adapter. On a machine with no GPU, current Chrome can still expose a SwiftShader adapter. The JSON field `webgpu_adapter` records vendor and architecture. SwiftShader is the WebGPU API running in software. It is not an RTX 3060. A 3060 still uses `--backend webgpu` with a current driver. If `chrome://gpu` does not show WebGPU, or `chrome://flags` has WebGPU disabled, fix that and rerun. A missing adapter is an error. The process does not switch to WASM on its own. `--backend wasm` is the explicit CPU path. It is refused above 256x256 unless you pass `--allow-slow-wasm`, because the compact network is a deep stack of convolutions and WASM on a 1080p frame is not a practical render.

Tiles default to 192 with overlap 16. One tile is resident in the session at a time, and tensors are disposed after each tile. The whole video is not accumulated on the GPU. A 3060 exists in 6 GB and 12 GB variants. This tool does not detect which one you have. If the Chrome tab is killed, lower `--tile` to 128. On a 12 GB card you can try 256. Overlap must be smaller than the tile. More than 4096 tiles in one frame is rejected.

Disk: the ONNX file is about 5 MB. `npm ci` downloads ONNX Runtime Web (the dist directory is on the order of 150 MB). The Python venv with the pinned runtime packages is a few hundred MB. Frames are piped, not written as a PNG sequence. Temp disk is the extracted audio clip, removed when the process exits, including on failure. A partial output file is deleted when the job fails so a rerun is not blocked and a bad file is not left behind as if it succeeded. Output size depends on duration, resolution, and CRF. Keep free space for the output plus the audio temp. RAM for 1080p to 4K is one input frame, the stitched 4K float buffer (about 100 MB), the previous enhanced frame for the temporal state, and Chrome. That is not a measured frames-per-second figure. None is claimed here.

HDR and 10-bit sources are rejected. The output is 8-bit yuv420p SDR. There is no PQ/HLG tonemap and no HDR metadata pass-through. Untagged SDR is tagged bt709 on the way out. Full-range sources are converted through RGB and back to limited-range yuv420p, which is the normal SDR encode path.

## Flags

| Flag | Default | Role |
| --- | --- | --- |
| `--input` | | source video, never modified |
| `--output` | | `.mkv`, `.mp4`, or `.webm`; must not exist |
| `--scale` | 2 | 2 or 4 |
| `--denoise` | low (0.25) | before upscale; 0/off skips it |
| `--sharpen` | off (0) | extra unsharp after upscale, before temporal |
| `--temporal-strength` | 0.35 | 0 disables the recurrent blend |
| `--scene-threshold` | 0.30 | mean RGB change that resets temporal state |
| `--tile` / `--overlap` | 192 / 16 | model tiling |
| `--backend` | webgpu | `webgpu` or `wasm` |
| `--encoder` | libsvtav1 | or `libaom-av1` |
| `--crf` | 32 | 0..63 |
| `--preset` | 8 | SVT 0..13, or libaom cpu-used 0..8 |
| `--threads` | 0 | 0 means min(8, CPU count); SVT `lp` |
| `--limit-frames` | 0 | first N frames; 0 means all |
| `--diagnostics` | | JSON report path |
| `--check-deps` | | ffmpeg, model, Chrome, local ORT files |
| `--check` | | deps plus one real inference against the golden tensor |
| `--offline-probe` | | prove non-loopback fetches are aborted |
| `--allow-slow-wasm` | | permit wasm above 256x256 |
| `--max-input-pixels` | 4194304 | reject larger frames |
| `--ffmpeg` `--ffprobe` `--chrome` `--model` `--ort-dist` | | path overrides |

Paths are passed as subprocess argument lists, so spaces in names are fine. The output is created with `O_EXCL` and then replaced only because this process just created that empty placeholder. An existing file is left unchanged.

## Tests

```bash
. .venv/bin/activate
python -m pytest -q
```

The suite covers denoise on/off and order, sharpen 0 versus a positive amount on a step edge, scene-cut reset, SVT `lp` and libaom AV1 encodes, VFR and 10-bit rejection, overwrite, paths with spaces, the loopback file server, and a full synthetic remaster: 32x32, four frames, a hard cut, a sine tone, `--backend wasm`, `--offline-probe`, `libsvtav1`, then ffprobe for `av1`, 64x64, four frames, and audio duration.

## What was run on the machine that built this tree

See `TEST_REPORT.md` after the test run. WebGPU was not executed where no GPU adapter exists. Windows was not executed from Linux. Do not treat a WASM run as a WebGPU run. `diagnostics` records `backend_used` and `webgpu_executed`.
