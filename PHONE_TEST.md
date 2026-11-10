# Phone app test notes

Recorded on a Linux machine with Google Chrome (headless), FFmpeg 6.1, and no NVIDIA GPU. This is not an iPhone test, not an Android test, and not an RTX test. WebGPU did not run. Enhance used WASM.

## What passed

- Service worker became active and the manifest named Master FNK, `standalone`, with 192 and 512 icons plus a maskable icon.
- First-run lock: password, 12-word phrase, and the three-word check.
- One wrong password showed “Try again in 5 seconds.”
- Editor accepted a 640×360 video, an 800×600 photo, and a wav song, with the Movie look at 720p.
- The finished file was H.264, 1280×720, 24 fps, 85 frames, 3.54 seconds, with an audio track. The on-screen line read `1280×720 · 3.5s · H.264`.
- Letterbox bars on a still frame were black `(0,0,0)`. The center pixel was not black.
- 1080p export of 8 graded frames: 1920×1080 H.264 in 1.6 seconds.
- 4K export of 6 graded frames: 3840×2160 H.264 in 2.0 seconds. The working picture was 1920×1080, then scaled.
- Enhance of a 640×360 clip: backend `wasm`, 2 model frames in 9.3 seconds, saved as 1280×720.
- Node tests covered scrypt wrapping, a wrong password, escalating lockouts, recovery that keeps an encrypted payload, and a tampered file that does not decrypt.
- The existing desktop command-line suite passed, including its end-to-end AV1 smoke. See `TEST_REPORT.md` for that older run’s environment. This machine’s rerun was `pytest`: 21 passed.

## Audio codec on this machine

This Chrome build could not encode AAC. The app fell back to Opus in the MP4. A phone that supports AAC uses AAC first. Opus was not claimed as the phone default.

## Not tested

- A physical phone, iOS Safari, or Android Chrome.
- WebGPU on a real GPU.
- Windows, and the desktop tool’s RTX path.
- GitHub Pages from this private repository. The token used here cannot change repository settings. Publishing needs the phone steps in the README.
