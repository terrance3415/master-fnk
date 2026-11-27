# master-fnk (v17 FINAL) — Design & Asset Handoff for Copilot

**Repository:** `https://github.com/terrance3415/master-fnk`
**This folder in the repo:** `design/v17-copilot-handoff/`
**Base branch:** `main` (PR #5 `cursor/nenc-android-apk-fbb5` and PR #6 are already merged; do not branch from the stale Android PR branch)
**Design Status:** v17 APPROVED FINAL (Nov 20, 2026)

Production backgrounds and transparent figures in `assets/` are identical to the copies already on `main` at `design/v17/`. This folder is the complete Copilot handoff package, including the newer Giles splash/home/share/vault screens, icon sets, and individual approved mockups that were not in `design/v17/`.

## Exact Color Palette
- **Base dark plum background:** `#130D19`
- **Video (Jean):** Pink `#C84F7A`
- **Music (Rogue):** Green `#5AC484`
- **Captured (Storm):** Blue-Violet `#4E58B9`
- **Export screen:** Each row uses its own category accent color, with the Trio header background and NO mini figures above the export progress bar.

## Included Folders
1. **`assets/`** — Production-ready app assets:
   - `bg_video_jean.jpg`, `bg_music_rogue.jpg`, `bg_captured_storm.jpg`, `bg_export_trio.jpg` (1080×2400 full-screen backgrounds)
   - `fig_jean_flying.png`, `fig_jean_landed.png` (512px-tall transparent PNGs — Jean in black-and-pink suit)
   - `fig_rogue_flying.png`, `fig_rogue_landed.png` (512px-tall transparent PNGs)
   - `fig_storm_flying.png`, `fig_storm_landed.png` (512px-tall transparent PNGs)
   - `fig_trio_flying.png`, `fig_trio_landed.png` (transparent PNGs)
2. **`mockups/`** — Approved v17 reference sheets & individual flying/landed screens:
   - `theme_v17_flying_sheet.jpg`, `theme_v17_landed_sheet.jpg`
   - `theme_video_1_flying_in.jpg`, `theme_video_2_landed.jpg`
   - `theme_music_1_flying_in.jpg`, `theme_music_2_landed.jpg`
   - `theme_captured_1_flying_in.jpg`, `theme_captured_2_landed.jpg`
   - `theme_export_1_flying_in.jpg`, `theme_export_2_landed.jpg`
3. **`giles_screens/`** — Matching v17 Splash, Home recolors, Share (Rogue green), and Vault (Storm locked/open) screens + `overview.jpg`.
4. **`icons/`** — App icon sets (60px, 120px, 180px, full-res PNGs + `icons-sheet.png`).

## Animation & Layout Notes for Copilot
- When switching tabs (**Video → Jean**, **Music → Rogue**, **Captured → Storm**), crossfade the full-screen background and theme accent color, and animate the matching mini character flying in (`fig_*_flying.png`) and landing (`fig_*_landed.png`) above the tab bar / action area as shown in `mockups/theme_v17_flying_sheet.jpg` and `mockups/theme_v17_landed_sheet.jpg`.
- On the **Export** screen, show `bg_export_trio.jpg` above the exporting progress bar with **no mini figures**, and keep each category row tinted in its own accent color.
- All encryption/decryption (`.nenc` AES-256-GCM) stays 100% local on-device.

## How to materialize the PNG/JPG files

The production-ready images are stored losslessly as base64 payloads in `payloads/` (`icons.manifest`, `assets.manifest`, `mockups.manifest`, `giles_screens.manifest`). After cloning this branch, run:

```bash
python3 design/v17-copilot-handoff/decode_assets.py
```

That writes the original PNG/JPG files into `assets/`, `mockups/`, `giles_screens/`, and `icons/`. Use those decoded files in the app; do not copy the `.manifest` sources into Android/web resource folders.

