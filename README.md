# Master FNK

A private movie studio you install on your phone. Pick videos and photos, give them a cinematic look, and save a film that is at least 720p. A password locks the app. Nothing is uploaded.

## Install it on your phone

The app is a website you add to your home screen. It is not an App Store download. After the site is published, open:

**https://terrance3415.github.io/master-fnk/**

That address is not live until the two taps in the next section. GitHub will show the same address on the Actions run when publishing finishes.

### Turn on the site from your phone

This repository is private. GitHub’s free plan will not publish a private repository to the web. The films and the password never go to GitHub either way. Only the app itself is published, and anyone with the address can open the app. Your films stay encrypted on the phone.

1. Open the GitHub app, or Safari / Chrome, and go to `github.com/terrance3415/master-fnk`.
2. Open the pull request and tap **Merge**.
3. Tap **Settings**. On a phone this is under the repository menu.
4. If you are on the free plan, tap **Change repository visibility** and make it **Public**. If you pay for GitHub Pro or higher, you can leave it private, then continue. The published website is still public either way.
5. Tap **Pages**, then under **Build and deployment** set **Source** to **GitHub Actions**.
6. Open the **Actions** tab. Wait until **Publish phone app** has a green check.
7. Open `https://terrance3415.github.io/master-fnk/`.

Each merge after that republishes the app. You do not type any commands.

### iPhone (Safari)

1. Open the address in Safari. Chrome on iPhone will not install it.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Tap **Add**. The icon is Master FNK.

Use a current iPhone system (iOS 17 or newer). Older Safari cannot save the finished film.

### Android (Chrome)

1. Open the address in Chrome.
2. Tap **Install app** when it appears, or open the Chrome menu and tap **Install app** or **Add to Home screen**.
3. Confirm. The icon is Master FNK.

### Android app file (optional)

An APK was not built. iPhones cannot install an APK. Android can install this site directly, which is the path above. If you later want a separate `.apk` file, [PWABuilder](https://www.pwabuilder.com/) can package the live address. That needs the site to be up first, plus a signing key. It was not run here.

## First time you open it

1. Choose a password of at least 8 characters and type it again.
2. Write down the 12 recovery words. They are shown once. They are the only way back in if you forget the password.
3. Type the three words the app asks for, so it knows you saved them.
4. Tap **Make a film**.

The lock lives in this phone, in this app. It is not an account. Closing the app locks it. The password is not stored. A random key unlocks the saved films, and that key is wrapped with scrypt (N = 32768, r = 8, p = 1) and AES-GCM. The recovery words wrap the same key, so a reset keeps the films.

A wrong password waits longer each time: 5 seconds, then 15, 30, 1 minute, 2, 5, 10, 30, 1 hour, then 4 hours. A wrong recovery phrase has its own waits, starting at 30 seconds and ending at 24 hours. Refreshing the page does not clear the wait. Moving the phone’s clock forward can shorten it. If you lose both the password and the words, the films on that phone cannot be opened. **Erase** on the lock screen deletes them and lets you start over.

## Make a film

1. Add one or more videos or photos. They play in order, with a short fade between them.
2. Add a song if you want music. That song is the soundtrack. The original sound in a clip is not kept.
3. Type a name if you want it written on the picture.
4. Pick a look: **Movie**, **Vintage film**, **Dramatic**, or **Clean remaster**.
5. Pick a size: **720p**, **1080p**, or **4K**.
6. Optional: denoise, sharpen, film grain, slow motion (2× or 4×), movie bars, and Enhance.
7. Tap **Create video**. Keep the screen open.
8. Play it, then **Download**. A copy also stays in the vault on the phone.

Movie, Vintage, and Dramatic add color, grain, and wide bars (2.39:1) inside the frame. Clean remaster is quieter and turns Enhance on. Enhance is the slow detail rebuild. Leave it off for a normal cinematic film.

Tall phone videos are fitted inside the wide frame with a soft background so the whole picture stays visible. Landscape videos fill the frame.

Slow motion blends neighboring frames. Fast motion can look ghosted. It is not optical-flow slow motion. A small stabilizer eases camera shake. It is not the heavier desktop stabilizer.

## Sizes, and how long it took in testing

Every saved film is one of these:

| Choice | File size | What the picture is |
| --- | --- | --- |
| 720p | 1280×720 | Drawn at 720p. |
| 1080p | 1920×1080 | Drawn at 1080p when Enhance is off. |
| 4K | 3840×2160 | The picture is built at 1080p and scaled up. Titles are drawn at 4K. |

Clips smaller than 720p are scaled up so the file is still at least 720p. Enhance rebuilds detail only for clips under 720p on the long side, up to about 720p of real model detail, using the compact Real-ESRGAN network. 1080p and 4K do not invent extra detail beyond that.

The phone will shorten a project that is too long, and it tells you. The caps are 60 seconds at 720p, 40 seconds at 1080p, and 20 seconds at 4K. With Enhance on, the cap is 8 seconds, or 4 seconds at 4K.

These times were measured in Chrome on a Linux machine with no NVIDIA GPU, not on a phone. Your phone will differ. WebGPU was not used here. The neural step used the CPU (WASM).

| What | Result |
| --- | --- |
| 720p film in the app | 1280×720 H.264, 24 fps, 3.5 seconds, 85 frames, music mixed. Source was a 640×360 clip plus a photo. |
| 1080p coloring, no Enhance | 8 frames in 1.6 seconds, about 0.2 seconds a frame. A 10 second film is on the order of a minute on this machine. |
| 4K coloring, no Enhance | 6 frames in 2.0 seconds, about 0.3 seconds a frame. The file was really 3840×2160. |
| Enhance | 2 rebuilt frames took 9.3 seconds of model time, about 4.6 seconds a frame, then scaled to 720p. An 8 second enhanced film is several minutes. |

A phone with a working graphics chip can use WebGPU for Enhance and may be faster. If it cannot, the app uses the processor and says so. The first Enhance also downloads about 20 MB, or about 35 MB when the graphics chip is used, plus the 5 MB model. After that it stays on the phone.

## What stays private

- No account, no analytics, no ads, and no content checks.
- Processing happens in the phone’s browser. Clips are not uploaded.
- The server, when GitHub is only delivering the app files, is not part of the film.
- Saved films are encrypted in the phone’s storage.

The published website is public. Do not put private videos into the GitHub repository.

## What does not work on the phone

- It does not write AV1. The phone file is H.264 so phones can play it. The optional computer command line still writes AV1.
- It does not keep the microphone audio from a clip. Add a music file.
- Enhance will not finish a long video in a short time.
- 4K is a large file whose picture detail is 1080p, scaled up.
- Very old phones cannot encode the finished video.
- This was not run on a physical iPhone, a physical Android phone, Windows, or an RTX 3060.

## Computer command line

You do not need this. It is the older local remaster tool and its checks. See `docs/desktop-cli.md` and `TEST_REPORT.md`. The model file `models/realesr-general-x4v3.onnx` is 4.7 MB, under GitHub’s file limit, so it is stored normally and not with Git LFS.
