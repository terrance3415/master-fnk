# Test report

Recorded on the Linux build VM after the suite below. This is not a Windows test and not an RTX 3060 test. `nvidia-smi` reported no GPU and `/dev/dri` was absent. Chrome's WebGPU adapter on this VM is SwiftShader (software).

## Environment

- Python 3.12.3, Node.js 22.23.4
- Google Chrome 156.0.8078.47
- FFmpeg 6.1.1-3ubuntu5, configured with `--enable-libsvtav1` (SVT-AV1 Encoder Lib v1.7.0) and `--enable-libaom`
- onnxruntime-web 1.31.1, loaded from `node_modules/onnxruntime-web/dist` over `http://127.0.0.1`
- Model `models/realesr-general-x4v3.onnx` (4,874,438 bytes), SHA-256 `623e9b84e38d32ff72419f97d1c5e54a1b308a8d3b4355d363ecdf1b10c2f2f2`
- Official weight SHA-256 `8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292` (Real-ESRGAN v0.2.5.0 `realesr-general-x4v3.pth`)

## Command

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
python -m pytest -q
```

Last full run, after the WebGPU adapter field was added:

```text
....................                                                     [100%]
20 passed in 12.27s
```

That run includes denoise on/off and pipeline order, sharpen 0 versus 0.5 on a step edge, scene-cut reset, tile-start parity with the worker, SVT `lp=2` and libaom-av1 encodes at 64x64, VFR rejection, 10-bit rejection, overwrite, loopback path traversal, and the end-to-end smoke below.

## End-to-end smoke (explicit WASM)

Inside `tests/test_smoke.py`. Synthetic 32x32, 10 fps, 4 frames, hard cut on frame 3, AAC sine. Output path contained spaces. Flags that actually ran:

```bash
python -m remaster --check --backend wasm --offline-probe --threads 2
python -m remaster \
  --input "clip dir/input clip.mp4" \
  --output "clip dir/remaster out.mkv" \
  --backend wasm --scale 2 --denoise low --sharpen low \
  --temporal-strength 0.35 --scene-threshold 0.30 \
  --crf 32 --preset 8 --threads 2 --encoder libsvtav1 \
  --offline-probe --diagnostics diagnostics.json
```

A second invocation against the same output exited nonzero with `already exists` and left the file in place. `--limit-frames 1` produced a separate 1-frame AV1 file.

ffprobe on the 4-frame sample (`/opt/cursor/artifacts/smoke-sample.mkv`):

- `codec_name=av1`, encoder tag `Lavc60.31.102 libsvtav1`
- 64x64 (32x32 source at scale 2; the x4 network is box-downsampled)
- `pix_fmt=yuv420p`, bt709, `r_frame_rate=10/1`, `nb_read_frames=4`
- video tag duration `00:00:00.400000000`
- audio `aac`, 48 kHz mono, tag duration `00:00:00.405000000` (5 ms, under one frame)
- container duration 0.405 s, start 0

Diagnostics (`/opt/cursor/artifacts/smoke-diagnostics.json`):

- `backend_used=wasm`, `webgpu_executed=false`, `execution_providers=["wasm"]`
- `listen_host=127.0.0.1`, `wasm_paths=http://127.0.0.1:<port>/ort/`
- requests were loopback except the deliberate `https://example.com/remaster-offline-probe`, which Playwright aborted before a socket (`offline_probe_blocked=true`, `blocked_remote_requests=[]`)
- local assets requested: `ort.all.min.js`, `ort-wasm-simd-threaded.jsep.wasm`, `model.onnx`
- `svt_thread_option=lp=2`, `svt_logical_cores=2` (the machine had 4 logical CPUs; lp capped the encoder)
- `scene_cuts=[3]`, `audio_mode=copy`, `trained_basicvsr=false`
- pipeline order: technical-validate, denoise, realesrgan-compact-ort-web, unsharp-additional, basicvsr-style-temporal, libsvtav1

The pytest assertion on `--check --backend wasm` required the worker output to be within 3 levels of the PyTorch golden and more than 3 levels away from bicubic. The model file is the Conv network described in `models/manifest.json` (`golden_mean_abs_diff_vs_bicubic` 8.608). It is not a bicubic stub.

## WebGPU check on this VM (SwiftShader, not an RTX)

```bash
python -m remaster --check --backend webgpu --threads 2 --offline-probe
```

Exit 0. Saved as `/opt/cursor/artifacts/webgpu-check.json`.

- `execution_providers=["webgpu"]`, `webgpu_executed=true`
- adapter: vendor `google`, architecture `swiftshader`, `isFallbackAdapter=false` (Chrome still reports SwiftShader in `architecture`)
- golden max abs 1, mean abs 0.0001, bicubic mean abs 8.6082, tiled-versus-full mean abs 0.5868
- same loopback wasm/js/model URLs and the same aborted example.com probe

So the ORT Web WebGPU provider did execute here, on SwiftShader. It did not execute on NVIDIA hardware. An RTX 3060 (6 GB or 12 GB; this tool does not detect which) was not available and was not tested. Windows was not tested.

## Not claimed

- No frames-per-second number
- No Windows run
- No RTX 3060 / hardware GPU run
- No trained BasicVSR model
- No HDR tonemap
- No H.264 or HEVC output
