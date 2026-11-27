import { encryptBlobChunked, decryptBlobChunked, decryptToSink, freeStorageBytes, spaceMessage } from "./blobs.mjs";
import { detectChapters } from "./chapters.mjs";
import { suggestCorrection } from "./color.mjs";
import { detectBeats } from "./audio.mjs";
import { encodeCanvasFilm } from "./encode.mjs";
import { FPS, PRESETS, RESOLUTIONS, applyPreset, buildTimeline, insertClipAt, outputSize } from "./filmmath.mjs";
import { FLIGHT_MS, LAND_AT_MS, flightSrc } from "./flight.mjs";
import { encryptBytes as nencEncrypt } from "./nenc.mjs";
import { renderFilm, sampleCorner } from "./render.mjs";
import { kvDel, kvGet, kvSet, wipeDb } from "./store.mjs";
import { cuesFromScript, toSrt, toVtt } from "./subs.mjs";
import { describeFrames } from "./tagger.mjs";
import { TAGGER_ID, editTags, groupSimilar, matchesTags } from "./tags.mjs";
import {
  MIN_PASSWORD,
  PRODUCTION_SCRYPT,
  createVault,
  decryptBytes,
  encryptBytes,
  formatWait,
  generatePhrase,
  phraseQuizIndexes,
  recover,
  unlock,
} from "./vault.mjs";

const STUDIO = {
  video: { label: "Video", color: "#C84F7A", bg: "./v17/bg_video_jean.jpg", fig: "./v17/fig_jean_landed.png", fly: "./v17/fig_jean_flying.png" },
  music: { label: "Music", color: "#5AC484", bg: "./v17/bg_music_rogue.jpg", fig: "./v17/fig_rogue_landed.png", fly: "./v17/fig_rogue_flying.png" },
  captured: { label: "Captured", color: "#4E58B9", bg: "./v17/bg_captured_storm.jpg", fig: "./v17/fig_storm_landed.png", fly: "./v17/fig_storm_flying.png" },
  export: { label: "Export", color: "#F4EFE6", bg: "./v17/bg_export_trio.jpg" },
};
let flightToken = 0;

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function scheduleLanding(mode) {
  const token = ++flightToken;
  const theme = STUDIO[mode];
  window.setTimeout(() => {
    if (token !== flightToken) return;
    document.querySelectorAll(`[data-flight="${mode}"]`).forEach((img) => {
      img.src = theme.fig;
    });
  }, LAND_AT_MS);
  window.setTimeout(() => {
    if (token !== flightToken) return;
    document.querySelectorAll(".flying").forEach((node) => node.classList.remove("flying"));
  }, FLIGHT_MS);
}

const app = document.getElementById("app");
const state = {
  screen: "working",
  working: "Opening…",
  error: "",
  record: null,
  vaultKey: null,
  slotId: null,
  tagQuery: "",
  people: [],
  tagging: null,
  pending: null,
  quiz: [],
  library: [],
  draft: null,
  blobs: new Map(),
  done: null,
  homeTheme: "jean",
  decoyHint: false,
  installEvent: null,
  timer: 0,
  abort: null,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function paint() {
  const flight = state.flight;
  const previousBg = state.transitionFrom && STUDIO[state.transitionFrom]?.bg;
  app.innerHTML = screens[state.screen] ? screens[state.screen]() : screens.working();
  state.flight = null;
  const previousMode = state.transitionFrom;
  state.transitionFrom = null;
  if (previousBg && !reducedMotion()) {
    const studio = app.querySelector(".studio");
    const nextColor = studio && getComputedStyle(studio).getPropertyValue("--mode").trim();
    if (studio && nextColor && previousMode !== state.draft?.studioMode) {
      studio.style.setProperty("--mode", STUDIO[previousMode].color);
      requestAnimationFrame(() => studio.style.setProperty("--mode", nextColor));
    }
    const stage = app.querySelector(".stage");
    const background = stage?.querySelector(".stage-bg");
    if (background && background.getAttribute("src") !== previousBg) {
      const previous = document.createElement("img");
      previous.className = "stage-bg stage-bg-previous";
      previous.src = previousBg;
      previous.alt = "";
      stage.insertBefore(previous, background);
      background.classList.add("crossfade");
      background.addEventListener("animationend", () => {
        previous.remove();
        background.classList.remove("crossfade");
      }, { once: true });
    }
  }
  if (flight && STUDIO[flight] && !reducedMotion()) scheduleLanding(flight);
  const wait = document.querySelector("[data-wait]");
  if (wait && state.record) startCountdown(state.record.passwordLockedUntil || state.record.recoveryLockedUntil || 0);
}

function installCard() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone || localStorage.getItem("fnk-install-hide") === "1") return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<section class="card install stack">
    <strong>Install on this phone</strong>
    <p class="note">${ios
      ? "Tap the Share button, then <b>Add to Home Screen</b>."
      : "In Chrome, tap the menu, then <b>Install app</b> or <b>Add to Home screen</b>."}</p>
    <div class="row">
      <button type="button" class="btn primary ${state.installEvent ? "" : "hidden"}" data-action="install">Install app</button>
      <button type="button" class="btn ghost" data-action="hide-install">Not now</button>
    </div>
  </section>`;
}

function field(id, label, type, extra = "") {
  return `<label>${esc(label)}<input id="${id}" name="${id}" type="${type}" ${extra} autocomplete="${type === "password" ? "current-password" : "off"}"></label>`;
}

const screens = {
  working() {
    return `<h1>Master FNK</h1><p class="lede">${esc(state.working)}</p>`;
  },
  blocked() {
    return `<h1>Master FNK</h1><p class="error">${esc(state.error || "This browser is blocking saved data. Leave private mode and open the app again.")}</p>`;
  },
  setup() {
    return `<h1>Master FNK</h1>
      <p class="lede">A private movie studio on this phone. Set a password before anything else. Nothing is uploaded.</p>
      ${installCard()}
      <form class="stack" data-action="create-lock">
        ${field("password", "Password", "password", `minlength="${MIN_PASSWORD}" required`)}
        ${field("password2", "Repeat the password", "password", `minlength="${MIN_PASSWORD}" required`)}
        ${field("second", "Second password, optional", "password", `minlength="${MIN_PASSWORD}"`)}
        ${field("second2", "Repeat the second password", "password", "")}
        <p class="note">At least ${MIN_PASSWORD} characters. You will get 12 recovery words next. They are shown once.</p>
        <p class="note">The second password opens a separate ordinary film library. Choose any password you like. A wrong password still just waits longer. The two passwords are not compared.</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn primary" type="submit">Create the lock</button>
      </form>
      <p class="footer">On this phone only. No account. No cloud.</p>`;
  },
  phrase() {
    const words = state.pending?.phrase || [];
    return `<h1>Write these down</h1>
      <p class="lede">These 12 words reset a forgotten password. They will not be shown again. If you lose them and the password, the films on this phone cannot be opened.</p>
      <ol class="words">${words.map((word, i) => `<li><b>${i + 1}</b> ${esc(word)}</li>`).join("")}</ol>
      <button type="button" class="btn ghost" data-action="copy-phrase">Copy the words</button>
      <form class="stack" data-action="confirm-phrase">
        <p>Type these words to prove you saved them.</p>
        ${state.quiz.map((index) => `<label>Word ${index + 1}<input data-quiz="${index}" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" required></label>`).join("")}
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn primary" type="submit">Save the lock</button>
      </form>`;
  },
  unlock() {
    const until = state.record?.passwordLockedUntil || 0;
    const locked = until > Date.now();
    return `<div class="vault-locked">
      <header class="topbar"><h1>Master FNK</h1><h2>Vault</h2></header>
      <div class="vault-lock-panel">
      <p class="lede">Enter the password for this phone.</p>
      ${installCard()}
      <form class="stack" data-action="unlock">
        ${field("password", "Password", "password", "required")}
        <p class="note" data-wait>${locked ? `Try again in ${esc(formatWait((until - Date.now()) / 1000))}.` : ""}</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn primary" type="submit" ${locked ? "disabled" : ""}>Unlock</button>
      </form>
      <button type="button" class="btn ghost" data-action="decoy">Open decoy vault</button>
      ${state.decoyHint ? `<p class="note">Enter the second password you chose when creating the vault. If you did not set one, a decoy vault is not available.</p>` : ""}
      <button type="button" class="btn ghost" data-action="show-recover">Forgot the password</button>
      <button type="button" class="btn danger" data-action="show-erase">Erase the lock and films on this phone</button>
      </div></div>`;
  },
  recover() {
    const until = state.record?.recoveryLockedUntil || 0;
    const locked = until > Date.now();
    return `<header class="topbar"><button type="button" class="icon" data-action="show-unlock">Back</button><h2>Recovery</h2></header>
      <form class="stack" data-action="recover">
        <label>The 12 words<textarea id="phrase" rows="4" required style="min-height:96px;border-radius:12px;border:1px solid var(--line);background:#0c0b0a;padding:12px;font-size:16px"></textarea></label>
        ${field("password", "New password", "password", `minlength="${MIN_PASSWORD}" required`)}
        ${field("password2", "Repeat the new password", "password", `minlength="${MIN_PASSWORD}" required`)}
        <p class="note" data-wait>${locked ? `Try again in ${esc(formatWait((until - Date.now()) / 1000))}.` : "A wrong phrase waits longer each time."}</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn primary" type="submit" ${locked ? "disabled" : ""}>Set a new password</button>
      </form>`;
  },
  erase() {
    return `<header class="topbar"><button type="button" class="icon" data-action="show-unlock">Back</button><h2>Erase</h2></header>
      <p class="lede">This deletes the password and every saved film on this phone. It cannot be undone.</p>
      <form class="stack" data-action="erase">
        <label>Type ERASE<input id="confirm" type="text" autocomplete="off" required></label>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn danger" type="submit">Erase everything</button>
      </form>`;
  },
  library() {
    const films = state.library.filter((project) => {
      const tags = (project.clips || []).flatMap((clip) => clip.tags || []);
      if (!state.tagQuery) return true;
      return matchesTags({ tags }, state.tagQuery) || (project.name || "").toLowerCase().includes(state.tagQuery.toLowerCase());
    });
    const cards = films.length
      ? films.map((project) => `<article class="card stack">
          <strong>${esc(project.name || "Untitled film")}</strong>
          <span class="note">${esc(project.status === "ready" ? `${project.output?.width || ""}×${project.output?.height || ""} ready` : "Draft")}</span>
          <div class="row">
            <button type="button" class="btn" data-action="open-project" data-id="${esc(project.id)}">${project.status === "ready" ? "Play" : "Continue"}</button>
            <button type="button" class="btn ghost" data-action="delete-project" data-id="${esc(project.id)}">Delete</button>
          </div>
        </article>`).join("")
      : `<p class="lede">No films yet.</p>`;
    return `<header class="topbar"><h2>Your films · Vault open</h2><button type="button" class="icon" data-action="lock">Lock</button></header>
      <section class="home-art home-${state.homeTheme}" aria-label="Master FNK home artwork"></section>
      <div class="home-themes" role="group" aria-label="Home artwork">
        ${["jean", "rogue", "storm"].map((theme) => `<button type="button" class="chip ${state.homeTheme === theme ? "on" : ""}" data-action="home-theme" data-theme="${theme}" aria-pressed="${state.homeTheme === theme}">${theme[0].toUpperCase() + theme.slice(1)}</button>`).join("")}
      </div>
      <div class="vault-open-art" role="img" aria-label="Storm vault artwork"></div>
      ${installCard()}
      <label>Find by tag<input id="tag-query" type="text" value="${esc(state.tagQuery || "")}" placeholder="beach night"></label>
      <button type="button" class="btn" data-action="apply-tag-filter">Filter</button>
      <button type="button" class="btn ghost" data-action="group-similar">Group similar videos</button>
      <button type="button" class="btn" data-action="tag-library">${state.tagging ? "Tagging…" : "Tag videos on this phone"}</button>
      <p class="note">Tagging uses a vision model stored with the app. It stays on this phone. You can leave and come back; finished videos are skipped.</p>
      ${(state.people || []).map((person) => `<label>${esc(person.name)}<input data-person="${esc(person.id)}" type="text" value="${esc(person.name)}" maxlength="40"></label>`).join("")}
      <div class="stack">${cards}</div>
      <button type="button" class="btn primary" data-action="new-film">Make a film</button>
      <p class="footer">Saved films stay encrypted on this phone. Closing the app locks it.</p>`;
  },
  edit() {
    const draft = state.draft;
    const mode = STUDIO[draft.studioMode] ? draft.studioMode : "video";
    const theme = STUDIO[mode];
    const flying = state.flight === mode && !reducedMotion();
    const figure = flightSrc(theme, !flying, 0);
    const plan = buildTimeline(draft.clips, draft);
    const videos = draft.clips.map((clip, index) => ({ clip, index })).filter((item) => item.clip.kind === "video");
    const photos = draft.clips.map((clip, index) => ({ clip, index })).filter((item) => item.clip.kind === "image");
    const panel = {
      video: `<section class="card stack">
          <button type="button" class="btn" data-action="pick-video">Add a video</button>
          ${videos.map((item) => clipCard(item.clip, item.index, draft)).join("") || `<p class="note">No videos yet. They play in order, with a fade between them.</p>`}
        </section>`,
      music: `<section class="card stack">
          <button type="button" class="btn" data-action="pick-music">${draft.music ? "Change music" : "Add music"}</button>
          ${draft.music ? `<p class="note">Music: ${esc(draft.music.name)}</p>` : `<p class="note">No song yet. The clip’s own sound can stay.</p>`}
          <div class="chips" aria-label="Clip sound">
            ${[["keep", "Keep sound"], ["duck", "Duck under song"], ["soften", "Softer TV"], ["mute", "Mute clip"]].map(([id, label]) => `<button type="button" class="chip ${(draft.audioMode || "keep") === id ? "on" : ""}" data-action="pick-audio" data-audio="${id}">${label}</button>`).join("")}
          </div>
          ${slider("cleanup", "Mic cleanup", draft.cleanup || 0)}
          ${slider("widen", "Stereo width", draft.widen || 0)}
          <label class="check"><input type="checkbox" data-field="beatSync" ${draft.beatSync ? "checked" : ""}> Snap cuts to the song’s beats</label>
        </section>`,
      captured: `<section class="card stack">
          <button type="button" class="btn" data-action="pick-photo">Add a photo</button>
          ${photos.map((item) => clipCard(item.clip, item.index, draft)).join("") || `<p class="note">No photos yet.</p>`}
        </section>`,
      export: `<section class="stack">
          <div class="export-rows">
            <div class="export-row video">Video · ${videos.length}</div>
            <div class="export-row music">Music · ${draft.music ? esc(draft.music.name) : "None"}</div>
            <div class="export-row captured">Captured · ${photos.length}</div>
          </div>
          <label>Name on the film<input id="film-name" data-field="name" type="text" maxlength="60" value="${esc(draft.name || "")}" placeholder="Optional title"></label>
          <div class="looks">
            ${Object.values(PRESETS).map((preset) => `<button type="button" class="look ${draft.look === preset.id ? "on" : ""}" data-action="pick-look" data-look="${preset.id}"><i class="swatch ${preset.id}"></i><b>${esc(preset.label)}</b><span>${esc(preset.blurb)}</span></button>`).join("")}
          </div>
          <div class="chips">
            ${Object.entries(RESOLUTIONS).map(([id, item]) => `<button type="button" class="chip ${draft.resolution === id ? "on" : ""}" data-action="pick-res" data-res="${id}">${esc(item.label)}</button>`).join("")}
          </div>
          <div class="chips" aria-label="Frame shape">
            ${["16:9", "9:16", "1:1"].map((aspect) => `<button type="button" class="chip ${draft.aspect === aspect ? "on" : ""}" data-action="pick-aspect" data-aspect="${aspect}">${aspect}</button>`).join("")}
          </div>
          <div class="chips" aria-label="Framing">
            ${[["fit", "Fit"], ["fill", "Fill"], ["crop", "Crop"]].map(([id, label]) => `<button type="button" class="chip ${draft.frame === id ? "on" : ""}" data-action="pick-frame" data-frame="${id}">${label}</button>`).join("")}
          </div>
          ${slider("denoise", "Denoise", draft.denoise)}
          ${slider("sharpen", "Sharpen", draft.sharpen)}
          ${slider("grain", "Film grain", draft.grain)}
          <div class="chips" aria-label="Slow motion">
            ${[1, 2, 4].map((value) => `<button type="button" class="chip ${draft.slowMo === value ? "on" : ""}" data-action="pick-slow" data-slow="${value}">${value === 1 ? "Normal" : `${value}× slow`}</button>`).join("")}
          </div>
          <label class="check"><input type="checkbox" data-field="letterbox" ${draft.letterbox ? "checked" : ""}> Wide movie bars (2.39:1)</label>
          ${slider("exposure", "Exposure", (Number(draft.exposure) + 1) / 2)}
          ${slider("temperature", "Warmth", (Number(draft.temperature) + 1) / 2)}
          ${slider("tint", "Tint", (Number(draft.tint) + 1) / 2)}
          ${slider("contrast", "Contrast", (Number(draft.contrast) + 1) / 2)}
          ${slider("cinematic", "Teal and orange", draft.cinematic || 0)}
          <button type="button" class="btn" data-action="auto-color">Auto color</button>
          <label class="check"><input type="checkbox" data-field="smooth" ${draft.smooth ? "checked" : ""}> Smooth low frame rates (slower)</label>
          <label class="check"><input type="checkbox" data-field="enhance" ${draft.enhance ? "checked" : ""}> Enhance small clips up to 720p</label>
          <label>Captions<textarea id="caption-script" rows="3">${esc((draft.cues || []).map((cue) => cue.text).join(" "))}</textarea></label>
          <p class="note plan">${plan.error ? esc(plan.error) : `${plan.duration.toFixed(1)}s · ${plan.frameCount} frames · ${esc(RESOLUTIONS[draft.resolution].label)}${plan.message ? ` · ${esc(plan.message)}` : ""}`}</p>
          <button type="button" class="btn primary" data-action="create-film" ${plan.error || !draft.clips.length ? "disabled" : ""}>Create video</button>
        </section>`,
    }[mode];
    return `<div class="studio mode-${mode}">
      <header class="studio-bar">
        <button type="button" class="icon" data-action="show-library">Back</button>
        <strong>master-fnk</strong>
        <span class="edit-mark">Edit</span>
        <button type="button" class="export-pill" data-action="pick-studio" data-studio="export">Export</button>
      </header>
      <div class="stage">
        <img class="stage-bg" src="${theme.bg}" alt="">
        ${figure ? `<img class="stage-fig ${flying ? "flying" : ""}" data-flight="${flying ? mode : ""}" src="${figure}" alt="">` : ""}
      </div>
      <nav class="mode-nav" aria-label="Editor mode">
        ${Object.entries(STUDIO).map(([id, item]) => {
          return `<button type="button" class="mode-btn ${id} ${mode === id ? "on" : ""} ${mode === id && flying ? "flying" : ""}" data-action="pick-studio" data-studio="${id}"><i></i><span>${item.label}</span>${mode === id && figure ? `<img data-flight="${flying ? mode : ""}" src="${figure}" alt="">` : ""}</button>`;
        }).join("")}
      </nav>
      <input id="media-input" class="hidden" type="file" accept="video/*,image/*" multiple>
      <input id="music-input" class="hidden" type="file" accept="audio/*">
      ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
      ${panel}
    </div>`;
  },
  render() {
    return `<div class="studio mode-export">
      <header class="studio-bar">
        <button type="button" class="icon" data-action="cancel-render">Stop</button>
        <strong>master-fnk</strong>
        <span class="edit-mark">Edit</span>
      </header>
      <div class="stage">
        <img class="stage-bg" src="${STUDIO.export.bg}" alt="">
        <div class="export-float">
          <p data-progress-label>${esc(state.working || "Starting…")}</p>
          <div class="progress" aria-hidden="true"><span data-progress-bar></span></div>
        </div>
        <div class="export-rows">
          <div class="export-row video">Video</div>
          <div class="export-row music">Music</div>
          <div class="export-row captured">Captured</div>
        </div>
      </div>
      <p class="note">Keep this screen open. A longer film, 1080p, or Enhance takes longer. 4K is the slowest.</p>
    </div>`;
  },
  done() {
    const done = state.done || {};
    return `<header class="topbar"><button type="button" class="icon" data-action="show-library">Films</button><h2>Ready</h2></header>
      <div class="compare">
        <video class="preview" data-compare="after" controls playsinline src="${done.url || ""}"></video>
        ${done.originalUrl ? `<video class="preview compare-before" data-compare="before" playsinline muted src="${done.originalUrl}"></video>` : ""}
      </div>
      ${done.originalUrl ? `<label class="slider">Compare<input id="compare-slider" type="range" min="0" max="100" value="100"><span class="val">After</span></label>` : ""}
      <p><b>${esc(done.width)}×${esc(done.height)}</b> · ${Number(done.duration || 0).toFixed(1)}s · H.264</p>
      ${(done.notes || []).map((note) => `<p class="note">${esc(note)}</p>`).join("")}
      <div class="stack">
        <button type="button" class="btn share" data-action="show-share">Share a locked copy</button>
        <p class="note">Asks for a share password. The file is a .nenc. It is not the vault password. The other person opens it in the Android app or with the Python tool.</p>
        <button type="button" class="btn ghost" data-action="download">Download an unprotected copy</button>
        <p class="note">Unprotected. Anyone with this file can watch it.</p>
        <button type="button" class="btn ghost" data-action="export-subs">Export subtitles</button>
        <button type="button" class="btn ghost" data-action="new-film">Make another</button>
      </div>
      <p class="footer">Saved in the vault on this phone. Download keeps a copy in your gallery or files.</p>`;
  },
  share() {
    return `<div class="share-screen">
      <header class="topbar"><button type="button" class="icon" data-action="show-done">Back</button><h2>Share</h2></header>
      <section class="share-panel stack">
        <h2>Share a locked copy</h2>
        <p>Encrypt before sharing · On</p>
        <p class="note">Choose Messages, Email, Files, or another destination in your device’s share sheet. A separate share password protects the .nenc file.</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button type="button" class="btn share" data-action="share-locked">Encrypt and share</button>
        <button type="button" class="btn ghost" data-action="download">Download an unprotected copy</button>
        <p class="note">Unprotected downloads can be watched by anyone with the file.</p>
      </section>
    </div>`;
  },
};

function clipCard(clip, index, draft) {
  const tags = (clip.tags || []).map((tag) => `<button type="button" class="chip" data-action="drop-tag" data-index="${index}" data-tag="${esc(tag.label)}">${esc(tag.label)}${tag.confidence === "low" ? "?" : ""}</button>`).join(" ");
  const chapters = (clip.chapters || []).map((chapter, chapterIndex) => `<button type="button" class="chip" data-action="rename-chapter" data-index="${index}" data-chapter="${chapterIndex}">${esc(chapter.title)} ${Number(chapter.time).toFixed(1)}s</button>`).join(" ");
  const videoBits = clip.kind !== "video" ? "" : `
    <div class="row">
      <label>Start sec<input data-clip="${index}" data-trim="trimIn" type="number" min="0" step="0.1" value="${Number(clip.trimIn || 0).toFixed(1)}"></label>
      <label>End sec<input data-clip="${index}" data-trim="trimOut" type="number" min="0" step="0.1" value="${Number(clip.trimOut || clip.duration || 0).toFixed(1)}"></label>
    </div>
    <div class="row">
      <label>Cut from<input data-clip="${index}" data-trim="cutIn" type="number" min="0" step="0.1" value="${clip.cutIn ?? ""}" placeholder="optional"></label>
      <label>Cut to<input data-clip="${index}" data-trim="cutOut" type="number" min="0" step="0.1" value="${clip.cutOut ?? ""}" placeholder="optional"></label>
    </div>
    <div class="row">
      <label>Insert clip #<input data-clip="${index}" data-trim="insertIndex" type="number" min="1" step="1" placeholder="2"></label>
      <label>At second<input data-clip="${index}" data-trim="insertAt" type="number" min="0" step="0.1" placeholder="0.0"></label>
    </div>
    <div class="row">
      <button type="button" class="btn" data-action="insert-clip" data-index="${index}">Insert</button>
      <button type="button" class="btn" data-action="find-scenes" data-index="${index}">Find scenes</button>
    </div>
    ${chapters ? `<div class="chips">${chapters}</div>` : ""}
    ${tags ? `<div class="chips">${tags}</div>` : `<p class="note">Tags appear after the clip is read.</p>`}`;
  return `<div class="clip stack">
    <div class="row">
      <div><b>${esc(clip.name || (clip.kind === "image" ? "Photo" : "Video"))}</b><div class="note">${clip.kind === "image" ? "Photo" : `${Number(clip.duration).toFixed(1)}s`} · ${clip.width}×${clip.height}</div></div>
      <div>
        <button type="button" data-action="move-clip" data-dir="-1" data-index="${index}" aria-label="Move earlier">↑</button>
        <button type="button" data-action="move-clip" data-dir="1" data-index="${index}" aria-label="Move later">↓</button>
        <button type="button" data-action="remove-clip" data-index="${index}">Remove</button>
      </div>
    </div>
    ${videoBits}
  </div>`;
}

function sliderValue(field, raw) {
  const unit = Number(raw) / 100;
  if (field === "exposure" || field === "temperature" || field === "tint" || field === "contrast") return unit * 2 - 1;
  return unit;
}

function slider(field, label, value) {
  const shown = Math.round(Number(value) * 100);
  return `<label class="slider">${esc(label)}<input type="range" min="0" max="100" value="${shown}" data-field="${field}"><span class="val">${shown}</span></label>`;
}

function startCountdown(until) {
  clearInterval(state.timer);
  if (!until || until <= Date.now()) return;
  state.timer = setInterval(() => {
    const node = document.querySelector("[data-wait]");
    if (!node) return;
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(state.timer);
      node.textContent = "You can try again.";
      const button = document.querySelector("button[type=submit]");
      if (button) button.disabled = false;
      return;
    }
    node.textContent = `Try again in ${formatWait(left)}.`;
  }, 250);
}

function serializable(project) {
  return {
    id: project.id,
    status: project.status,
    name: project.name || "",
    openingTitle: (project.name || "").trim(),
    look: project.look,
    letterbox: project.letterbox,
    grain: project.grain,
    denoise: project.denoise,
    sharpen: project.sharpen,
    enhance: project.enhance,
    slowMo: project.slowMo,
    vignette: project.vignette,
    grade: project.grade,
    resolution: project.resolution,
    exposure: project.exposure || 0,
    temperature: project.temperature || 0,
    tint: project.tint || 0,
    contrast: project.contrast || 0,
    cinematic: project.cinematic || 0,
    audioMode: project.audioMode || "keep",
    cleanup: project.cleanup || 0,
    widen: project.widen || 0,
    smooth: Boolean(project.smooth),
    aspect: project.aspect || "16:9",
    frame: project.frame || "fit",
    beatSync: Boolean(project.beatSync),
    studioMode: project.studioMode || "video",
    beats: project.beats || [],
    cues: project.cues || [],
    clips: project.clips.map((clip) => ({
      id: clip.id,
      kind: clip.kind,
      name: clip.name,
      duration: clip.duration,
      width: clip.width,
      height: clip.height,
      type: clip.type,
      fileId: clip.fileId,
      trimIn: clip.trimIn ?? 0,
      trimOut: clip.trimOut ?? clip.duration ?? 0,
      cutIn: clip.cutIn ?? null,
      cutOut: clip.cutOut ?? null,
      tags: clip.tags || [],
      embedding: clip.embedding || null,
      facets: clip.facets || null,
      tagger: clip.tagger || "",
      chapters: clip.chapters || [],
    })),
    music: project.music
      ? { name: project.music.name, type: project.music.type, fileId: project.music.fileId }
      : null,
    output: project.output || null,
    updatedAt: Date.now(),
  };
}

function libraryKey() {
  return state.slotId ? `lib:${state.slotId}` : "library";
}

async function persist() {
  const payload = new TextEncoder().encode(JSON.stringify({ projects: state.library.map(serializable), people: state.people || [] }));
  const enc = await encryptBytes(state.vaultKey, payload);
  await kvSet(libraryKey(), { iv: enc.iv, ct: enc.ct });
}

function upsert(project) {
  const copy = serializable(project);
  const index = state.library.findIndex((item) => item.id === copy.id);
  if (index >= 0) state.library[index] = copy;
  else state.library.unshift(copy);
}

async function saveDraft() {
  upsert(state.draft);
  await persist();
}

function blankDraft() {
  return {
    id: crypto.randomUUID(),
    status: "draft",
    name: "",
    ...applyPreset("movie"),
    resolution: "720",
    slowMo: 1,
    exposure: 0,
    temperature: 0,
    tint: 0,
    contrast: 0,
    cinematic: 0,
    audioMode: "keep",
    cleanup: 0,
    widen: 0,
    smooth: false,
    aspect: "16:9",
    frame: "fit",
    beatSync: false,
    beats: [],
    studioMode: "video",
    cues: [],
    clips: [],
    music: null,
    output: null,
  };
}

async function rememberFile(file) {
  const free = await freeStorageBytes();
  const message = spaceMessage(free, file.size || 0);
  if (message) throw new Error(message);
  const fileId = crypto.randomUUID();
  if ((file.size || 0) > 8 * 1024 * 1024) {
    const meta = await encryptBlobChunked(state.vaultKey, file, async (index, part) => {
      await kvSet(`file:${fileId}:${index}`, part);
    });
    await kvSet(`file:${fileId}:meta`, meta);
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const enc = await encryptBytes(state.vaultKey, bytes);
    await kvSet(`file:${fileId}`, { iv: enc.iv, ct: enc.ct });
  }
  state.blobs.set(fileId, file);
  return fileId;
}

async function deleteStored(fileId) {
  const meta = await kvGet(`file:${fileId}:meta`);
  if (meta?.chunks) {
    for (let index = 0; index < meta.chunks; index++) await kvDel(`file:${fileId}:${index}`);
    await kvDel(`file:${fileId}:meta`);
  }
  await kvDel(`file:${fileId}`);
}

function blobFor(meta) {
  const blob = state.blobs.get(meta.fileId);
  if (!blob) throw new Error("A clip is missing from this phone.");
  return blob;
}

async function hydrate(project) {
  const ids = [
    ...project.clips.map((clip) => clip.fileId),
    project.music?.fileId,
    project.output?.fileId,
  ].filter(Boolean);
  for (const fileId of ids) {
    if (state.blobs.has(fileId)) continue;
    const chunkMeta = await kvGet(`file:${fileId}:meta`);
    const saved = chunkMeta ? null : await kvGet(`file:${fileId}`);
    if (!chunkMeta && !saved) continue;
    const meta = project.clips.find((clip) => clip.fileId === fileId) || project.music || {};
    const type = meta.type || (project.output?.fileId === fileId ? "video/mp4" : "");
    let blob;
    if (chunkMeta && chunkMeta.bytes > 32 * 1024 * 1024 && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(`film-${fileId}`, { create: true });
      const writable = await handle.createWritable();
      await decryptToSink(state.vaultKey, chunkMeta, (index) => kvGet(`file:${fileId}:${index}`), (plain) => writable.write(plain));
      await writable.close();
      blob = await handle.getFile();
    } else if (chunkMeta) {
      blob = await decryptBlobChunked(state.vaultKey, { ...chunkMeta, type }, (index) => kvGet(`file:${fileId}:${index}`));
    } else {
      const bytes = await decryptBytes(state.vaultKey, saved);
      blob = new Blob([bytes], { type });
    }
    state.blobs.set(fileId, blob);
  }
}

function readPasswords() {
  const password = document.getElementById("password")?.value || "";
  const again = document.getElementById("password2")?.value || "";
  return { password, again };
}

async function failAuth(err) {
  if (err.record) {
    state.record = err.record;
    await kvSet("vault", err.record);
  }
  state.error = err.code === "locked" ? `Try again in ${formatWait(err.waitSeconds)}.` : err.message;
  paint();
}

const actions = {
  async "create-lock"(button) {
    button?.closest("form")?.requestSubmit?.();
  },
  async "confirm-phrase"() {},
  async unlock() {},
  "show-recover"() {
    state.error = "";
    state.screen = "recover";
    paint();
  },
  "show-unlock"() {
    state.error = "";
    state.decoyHint = false;
    state.screen = "unlock";
    paint();
  },
  "show-erase"() {
    state.error = "";
    state.screen = "erase";
    paint();
  },
  "show-library"() {
    state.screen = "library";
    state.error = "";
    paint();
  },
  decoy() {
    state.decoyHint = true;
    paint();
    document.getElementById("password")?.focus();
  },
  "home-theme"(button) {
    if (!["jean", "rogue", "storm"].includes(button.dataset.theme)) return;
    state.homeTheme = button.dataset.theme;
    paint();
  },
  "show-share"() {
    state.error = "";
    state.screen = "share";
    paint();
  },
  "show-done"() {
    state.error = "";
    state.screen = "done";
    paint();
  },
  lock() {
    if (state.vaultKey) state.vaultKey.fill(0);
    state.vaultKey = null;
    state.slotId = null;
    state.blobs.clear();
    state.draft = null;
    state.done = null;
    state.error = "";
    state.screen = "unlock";
    paint();
  },
  "hide-install"() {
    localStorage.setItem("fnk-install-hide", "1");
    paint();
  },
  async install() {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    await state.installEvent.userChoice.catch(() => {});
    state.installEvent = null;
    paint();
  },
  async "copy-phrase"() {
    const words = (state.pending?.phrase || []).map((word, i) => `${i + 1}. ${word}`).join("\n");
    try {
      await navigator.clipboard.writeText(words);
      state.error = "";
    } catch {
      state.error = "Copy isn’t available. Write the words down.";
      paint();
    }
  },
  "new-film"() {
    state.draft = blankDraft();
    state.error = "";
    state.screen = "edit";
    paint();
  },
  "pick-media"() {
    document.getElementById("media-input")?.click();
  },
  "pick-video"() {
    const input = document.getElementById("media-input");
    if (!input) return;
    input.accept = "video/*";
    input.click();
  },
  "pick-photo"() {
    const input = document.getElementById("media-input");
    if (!input) return;
    input.accept = "image/*";
    input.click();
  },
  "pick-studio"(button) {
    if (!state.draft) return;
    const next = button.dataset.studio;
    if (!STUDIO[next]) return;
    state.transitionFrom = state.draft.studioMode || "video";
    state.draft.studioMode = next;
    state.flight = next !== "export" && !reducedMotion() ? next : null;
    paint();
    saveDraft();
  },
  "pick-music"() {
    document.getElementById("music-input")?.click();
  },
  "pick-look"(button) {
    const next = applyPreset(button.dataset.look);
    state.draft = { ...state.draft, ...next, name: state.draft.name, clips: state.draft.clips, music: state.draft.music, id: state.draft.id, status: "draft", output: null };
    state.error = "";
    paint();
  },
  "pick-res"(button) {
    state.draft.resolution = button.dataset.res;
    state.error = "";
    paint();
  },
  "pick-slow"(button) {
    state.draft.slowMo = Number(button.dataset.slow);
    paint();
  },
  "move-clip"(button) {
    const index = Number(button.dataset.index);
    const dir = Number(button.dataset.dir);
    const next = index + dir;
    if (next < 0 || next >= state.draft.clips.length) return;
    const clips = state.draft.clips;
    [clips[index], clips[next]] = [clips[next], clips[index]];
    saveDraft().then(paint);
  },
  async "remove-clip"(button) {
    const [clip] = state.draft.clips.splice(Number(button.dataset.index), 1);
    if (clip && !state.draft.clips.some((item) => item.fileId === clip.fileId)) {
      state.blobs.delete(clip.fileId);
      await deleteStored(clip.fileId);
    }
    await saveDraft();
    paint();
  },
  async "open-project"(button) {
    const project = state.library.find((item) => item.id === button.dataset.id);
    if (!project) return;
    await hydrate(project);
    if (project.status === "ready" && project.output) {
      const blob = state.blobs.get(project.output.fileId);
      state.done = {
        url: URL.createObjectURL(blob),
        width: project.output.width,
        height: project.output.height,
        duration: project.output.duration,
        notes: ["Opened from the vault on this phone."],
        filename: fileName(project.name),
      };
      state.screen = "done";
      paint();
      return;
    }
    state.draft = { ...applyPreset(project.look || "movie"), ...project, clips: project.clips.map((clip) => ({ ...clip })) };
    state.screen = "edit";
    paint();
  },
  async "delete-project"(button) {
    const project = state.library.find((item) => item.id === button.dataset.id);
    if (!project) return;
    const ids = [...(project.clips || []).map((clip) => clip.fileId), project.music?.fileId, project.output?.fileId];
    for (const fileId of ids.filter(Boolean)) {
      state.blobs.delete(fileId);
      await deleteStored(fileId);
    }
    state.library = state.library.filter((item) => item.id !== project.id);
    await persist();
    paint();
  },
  "cancel-render"() {
    state.abort?.abort();
  },
  async "create-film"(button) {
    if (button.disabled) return;
    syncDraftFromDom();
    const plan = buildTimeline(state.draft.clips, state.draft);
    if (plan.error || !state.draft.clips.length) {
      state.error = plan.error || "Add a video or a photo first.";
      paint();
      return;
    }
    state.abort = new AbortController();
    state.screen = "render";
    state.working = "Starting…";
    state.error = "";
    paint();
    const project = {
      ...state.draft,
      openingTitle: (state.draft.name || "").trim(),
      clips: state.draft.clips.map((clip) => ({ ...clip, blob: blobFor(clip) })),
      music: state.draft.music ? { ...state.draft.music, blob: blobFor(state.draft.music) } : null,
    };
    try {
      const result = await renderFilm(project, plan, {
        signal: state.abort.signal,
        onProgress(progress) {
          const label = document.querySelector("[data-progress-label]");
          const bar = document.querySelector("[data-progress-bar]");
          if (label) label.textContent = progress.label;
          if (bar) bar.style.width = `${Math.round((progress.frame / progress.total) * 100)}%`;
        },
      });
      const free = await freeStorageBytes();
      const message = spaceMessage(free, result.blob.size || 0);
      if (message) throw new Error(message);
      const fileId = crypto.randomUUID();
      if ((result.blob.size || 0) > 8 * 1024 * 1024) {
        const meta = await encryptBlobChunked(state.vaultKey, result.blob, async (index, part) => {
          await kvSet(`file:${fileId}:${index}`, part);
        });
        await kvSet(`file:${fileId}:meta`, meta);
      } else {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        const enc = await encryptBytes(state.vaultKey, bytes);
        await kvSet(`file:${fileId}`, { iv: enc.iv, ct: enc.ct });
      }
      state.blobs.set(fileId, result.blob);
      state.draft.status = "ready";
      state.draft.output = {
        fileId,
        width: result.width,
        height: result.height,
        duration: result.duration,
        bytes: result.blob.size,
      };
      await saveDraft();
      state.done = {
        url: URL.createObjectURL(result.blob),
        width: result.width,
        height: result.height,
        duration: result.duration,
        notes: result.notes,
        filename: fileName(state.draft.name),
        originalUrl: originalPreviewUrl(),
        blob: result.blob,
        ms: result.ms,
        backend: result.backend,
      };
      state.screen = "done";
      paint();
    } catch (err) {
      if (err?.name === "AbortError") {
        state.error = "Stopped. Nothing new was saved.";
      } else {
        state.error = friendly(err);
      }
      state.screen = "edit";
      paint();
    }
  },
  download() {
    const link = document.createElement("a");
    link.href = state.done.url;
    link.download = state.done.filename || "film.mp4";
    document.body.appendChild(link);
    link.click();
    link.remove();
  },
  "pick-aspect"(button) {
    state.draft.aspect = button.dataset.aspect;
    if (state.draft.aspect !== "16:9") state.draft.letterbox = false;
    paint();
  },
  "pick-frame"(button) {
    state.draft.frame = button.dataset.frame;
    paint();
  },
  "pick-audio"(button) {
    state.draft.audioMode = button.dataset.audio;
    paint();
  },
  async "auto-color"() {
    const clip = state.draft.clips.find((item) => item.kind === "video") || state.draft.clips[0];
    if (!clip) return;
    const sample = await sampleClipFrame(blobFor(clip), Math.min(1, (Number(clip.duration) || 1) * 0.2));
    if (!sample) {
      state.error = "Could not sample that clip for auto color.";
      paint();
      return;
    }
    const suggestion = suggestCorrection(sample.rgba);
    Object.assign(state.draft, suggestion);
    await saveDraft();
    paint();
  },
  async "insert-clip"(button) {
    const host = Number(button.dataset.index);
    const card = button.closest(".clip");
    const incoming = Number(card.querySelector("[data-trim=insertIndex]")?.value) - 1;
    const at = Number(card.querySelector("[data-trim=insertAt]")?.value);
    if (!Number.isInteger(incoming) || !state.draft.clips[incoming]) {
      state.error = "Type the clip number to insert, starting at 1.";
      paint();
      return;
    }
    state.draft.clips = insertClipAt(state.draft.clips, host, incoming, at);
    state.error = "";
    await saveDraft();
    paint();
  },
  async "find-scenes"(button) {
    const index = Number(button.dataset.index);
    const clip = state.draft.clips[index];
    if (!clip || clip.kind !== "video") return;
    const found = await sampleChapters(blobFor(clip), clip);
    clip.chapters = found;
    if (found.length > 1) {
      const pieces = [];
      for (let i = 0; i < found.length; i++) {
        const start = found[i].time;
        const end = found[i + 1]?.time || Number(clip.trimOut || clip.duration);
        pieces.push({ ...clip, id: crypto.randomUUID(), name: found[i].title, trimIn: start, trimOut: end, cutIn: null, cutOut: null, chapters: [] });
      }
      state.draft.clips.splice(index, 1, ...pieces);
    }
    await saveDraft();
    paint();
  },
  async "rename-chapter"(button) {
    const clip = state.draft.clips[Number(button.dataset.index)];
    const chapter = clip?.chapters?.[Number(button.dataset.chapter)];
    if (!chapter) return;
    const title = window.prompt("Scene name", chapter.title);
    if (title) chapter.title = title.slice(0, 60);
    await saveDraft();
    paint();
  },
  async "drop-tag"(button) {
    const clip = state.draft.clips[Number(button.dataset.index)];
    if (!clip) return;
    clip.tags = editTags(clip.tags, { remove: button.dataset.tag });
    await saveDraft();
    paint();
  },
  "apply-tag-filter"() {
    state.tagQuery = document.getElementById("tag-query")?.value || "";
    paint();
  },
  async "tag-library"() {
    if (state.tagging) return;
    const queue = [];
    for (const project of state.library) {
      for (const clip of project.clips || []) {
        if (clip.kind === "video" && clip.tagger !== TAGGER_ID) queue.push({ project, clip });
      }
    }
    if (!queue.length) {
      state.error = "Every saved video already has tags from this model.";
      paint();
      return;
    }
    state.tagging = { done: 0, total: queue.length };
    state.error = "";
    paint();
    for (const item of queue) {
      try {
        await hydrate(item.project);
        const file = state.blobs.get(item.clip.fileId);
        if (file) await applyTags(item.clip, file);
      } catch (err) {
        state.error = friendly(err);
      }
      state.tagging.done += 1;
      await persist();
      const node = document.querySelector("[data-action=tag-library]");
      if (node) node.textContent = `Tagging ${state.tagging.done} of ${state.tagging.total}`;
    }
    state.tagging = null;
    paint();
  },
  async "group-similar"() {
    const items = [];
    for (const project of state.library) {
      for (const clip of project.clips || []) {
        if (clip.embedding) items.push({ ...clip, projectId: project.id, projectName: project.name });
      }
    }
    const groups = groupSimilar(items, 0.9);
    if (!groups.length) {
      state.error = "No group yet. Videos only group when several details match, not just the room or the colors. Tag the library first.";
      paint();
      return;
    }
    const draft = blankDraft();
    draft.name = "Similar clips";
    const seen = new Set();
    for (const item of groups[0]) {
      if (seen.has(item.fileId)) continue;
      seen.add(item.fileId);
      draft.clips.push({ ...item });
    }
    state.draft = draft;
    state.error = "";
    state.screen = "edit";
    await saveDraft();
    paint();
  },
  async "share-locked"() {
    const blob = state.done?.blob;
    if (!blob) return;
    const password = window.prompt("Share password. The other person needs this. It is not your vault password.");
    if (!password) return;
    const again = window.prompt("Repeat the share password");
    if (password !== again) {
      state.error = "The share passwords don’t match.";
      paint();
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sealed = await nencEncrypt(bytes, password, { chunkSize: 1024 * 1024 });
    const file = new File([sealed], (state.done.filename || "film.mp4").replace(/\.mp4$/, "") + ".nenc", { type: "application/octet-stream" });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Locked video" });
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
  },
  "export-subs"() {
    const cues = state.draft?.cues || [];
    const text = toVtt(cues.length ? cues : []);
    const blob = new Blob([cues.length ? text : toSrt([])], { type: "text/vtt" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "captions.vtt";
    link.click();
  },
};

function fileName(name) {
  const clean = String(name || "film").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${clean || "film"}.mp4`;
}

function friendly(err) {
  const text = String(err?.message || err);
  if (/VideoEncoder|save a finished video/i.test(text)) return text;
  if (/quota/i.test(text)) return text;
  return text || "Something went wrong while building the film.";
}

function syncDraftFromDom() {
  if (!state.draft) return;
  const name = document.getElementById("film-name");
  if (name) state.draft.name = name.value;
  document.querySelectorAll("[data-field]").forEach((input) => {
    if (input.type === "range") state.draft[input.dataset.field] = sliderValue(input.dataset.field, input.value);
    if (input.type === "checkbox") state.draft[input.dataset.field] = input.checked;
    if (input.id === "film-name") state.draft.name = input.value;
  });
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  if (button.type === "submit") return;
  const fn = actions[button.dataset.action];
  if (fn) fn(button);
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  const action = form.dataset.action;
  state.error = "";
  if (action === "create-lock") {
      const { password, again } = readPasswords();
      const second = document.getElementById("second")?.value || "";
      const second2 = document.getElementById("second2")?.value || "";
      if (second || second2) {
        if (second.length < MIN_PASSWORD) {
          state.error = `The second password needs at least ${MIN_PASSWORD} characters.`;
          paint();
          return;
        }
        if (second !== second2) {
          state.error = "The second passwords don’t match.";
          paint();
          return;
        }
        if (second === password) {
          state.error = "Use a different second password.";
          paint();
          return;
        }
      }
      if (password.length < MIN_PASSWORD) {
      state.error = `Use at least ${MIN_PASSWORD} characters.`;
      paint();
      return;
    }
    if (password !== again) {
      state.error = "The passwords don’t match.";
      paint();
      return;
    }
    state.screen = "working";
    state.working = "Creating the lock…";
    paint();
    try {
      const phrase = generatePhrase();
      state.pending = await createVault(password, phrase, PRODUCTION_SCRYPT, second || null);
      state.quiz = phraseQuizIndexes(12, 3);
      state.screen = "phrase";
      paint();
    } catch (err) {
      state.error = err.message;
      state.screen = "setup";
      paint();
    }
    return;
  }
  if (action === "confirm-phrase") {
    const words = state.pending?.phrase || [];
    for (const input of form.querySelectorAll("[data-quiz]")) {
      const index = Number(input.dataset.quiz);
      if (input.value.trim().toLowerCase() !== words[index]) {
        state.error = "Those words don’t match. They’re still listed above.";
        paint();
        return;
      }
    }
    await kvSet("vault", state.pending.record);
    state.record = state.pending.record;
    state.vaultKey = state.pending.vaultKey;
    state.pending = null;
    state.library = [];
    await persist();
    state.screen = "library";
    paint();
    return;
  }
  if (action === "unlock") {
    const password = document.getElementById("password").value;
    state.screen = "working";
    state.working = "Checking the password…";
    paint();
    try {
      const opened = await unlock(state.record, password);
      state.record = opened.record;
      state.vaultKey = opened.vaultKey;
      state.slotId = opened.slotId || null;
      await kvSet("vault", opened.record);
      await loadLibrary();
      state.screen = "library";
      paint();
    } catch (err) {
      state.screen = "unlock";
      await failAuth(err);
    }
    return;
  }
  if (action === "recover") {
    const phrase = document.getElementById("phrase").value;
    const { password, again } = readPasswords();
    if (password !== again) {
      state.error = "The passwords don’t match.";
      paint();
      return;
    }
    state.screen = "working";
    state.working = "Checking the recovery words…";
    paint();
    try {
      const opened = await recover(state.record, phrase, password);
      state.record = opened.record;
      state.vaultKey = opened.vaultKey;
      state.slotId = opened.slotId || null;
      await kvSet("vault", opened.record);
      await loadLibrary();
      state.screen = "library";
      paint();
    } catch (err) {
      state.screen = "recover";
      await failAuth(err);
    }
    return;
  }
  if (action === "erase") {
    if (document.getElementById("confirm").value.trim() !== "ERASE") {
      state.error = "Type ERASE to confirm.";
      paint();
      return;
    }
    if (state.vaultKey) state.vaultKey.fill(0);
    state.vaultKey = null;
    state.slotId = null;
    state.blobs.clear();
    await wipeDb();
    state.record = null;
    state.library = [];
    state.screen = "setup";
    paint();
  }
});

app.addEventListener("input", (event) => {
  const input = event.target;
  if (input.id === "compare-slider") {
    const before = document.querySelector("[data-compare=before]");
    if (before) before.style.clipPath = `inset(0 ${input.value}% 0 0)`;
    return;
  }
  if (!state.draft) return;
  if (input.id === "film-name") state.draft.name = input.value;
  if (input.dataset?.person && state.people) {
    const person = state.people.find((item) => item.id === input.dataset.person);
    if (person) person.name = input.value.slice(0, 40);
  }
  if (input.id === "caption-script") {
    const plan = buildTimeline(state.draft.clips, state.draft);
    state.draft.cues = cuesFromScript(input.value, plan.duration || 1);
  }
  if (input.dataset.field && input.type === "range") {
    state.draft[input.dataset.field] = sliderValue(input.dataset.field, input.value);
    const val = input.parentElement.querySelector(".val");
    if (val) val.textContent = input.value;
  }
  if (input.type === "checkbox" && input.dataset.field) state.draft[input.dataset.field] = input.checked;
  const plan = buildTimeline(state.draft.clips, state.draft);
  const node = document.querySelector(".plan");
  if (node) {
    node.textContent = plan.error
      ? plan.error
      : `${plan.duration.toFixed(1)}s · ${plan.frameCount} frames · ${RESOLUTIONS[state.draft.resolution].label}${plan.message ? ` · ${plan.message}` : ""}`;
  }
  const create = document.querySelector("[data-action=create-film]");
  if (create) create.disabled = Boolean(plan.error) || state.draft.clips.length === 0;
});

app.addEventListener("play", (event) => {
  if (event.target?.dataset?.compare !== "after") return;
  const before = document.querySelector("[data-compare=before]");
  if (!before) return;
  before.currentTime = event.target.currentTime;
  before.play().catch(() => {});
}, true);

app.addEventListener("change", async (event) => {
  if (event.target?.dataset?.person) {
    await persist();
  }
  if (event.target?.dataset?.trim && state.draft) {
    const name = event.target.dataset.trim;
    if (name !== "insertIndex" && name !== "insertAt") {
      const clip = state.draft.clips[Number(event.target.dataset.clip)];
      if (clip) {
        clip[name] = event.target.value === "" ? null : Number(event.target.value);
        await saveDraft();
        const plan = buildTimeline(state.draft.clips, state.draft);
        const node = document.querySelector(".plan");
        if (node) node.textContent = plan.error || `${plan.duration.toFixed(1)}s · ${plan.frameCount} frames`;
      }
    }
  }
  if (event.target.id === "media-input") {
    state.error = "";
    state.screen = "working";
    state.working = "Saving the clip on this phone…";
    paint();
    try {
      for (const file of event.target.files || []) {
        if (state.draft.clips.length >= 8) {
          state.error = "Eight clips is the limit.";
          break;
        }
        const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "";
        if (!kind) {
          state.error = "Choose a video or a photo.";
          continue;
        }
        const meta = await inspectFile(file, kind);
        const fileId = await rememberFile(file);
        const clip = {
          id: crypto.randomUUID(),
          kind,
          name: file.name,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          type: file.type,
          fileId,
          trimIn: 0,
          trimOut: meta.duration,
          tags: [],
          chapters: [],
        };
        if (kind === "video" && file.size < 400 * 1024 * 1024) {
          try {
            await applyTags(clip, file);
          } catch {
            clip.tags = [];
          }
        }
        state.draft.clips.push(clip);
      }
      await saveDraft();
      state.screen = "edit";
      paint();
    } catch (err) {
      state.error = friendly(err);
      state.screen = "edit";
      paint();
    }
  }
  if (event.target.id === "music-input") {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (state.draft.music) {
        state.blobs.delete(state.draft.music.fileId);
        await kvDel(`file:${state.draft.music.fileId}`);
      }
      const fileId = await rememberFile(file);
      state.draft.music = { name: file.name, type: file.type || "audio/*", fileId };
      const beatPcm = await decodeMusicPeaks(file);
      if (beatPcm) state.draft.beats = detectBeats(beatPcm.samples, beatPcm.sampleRate);
      await saveDraft();
      paint();
    } catch (err) {
      state.error = friendly(err);
      paint();
    }
  }
});

function inspectFile(file, kind) {
  const url = URL.createObjectURL(file);
  if (kind === "image") {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: image.naturalWidth, height: image.naturalHeight, duration: 0 });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That photo could not be opened. Try a JPG or PNG."));
      };
      image.src = url;
    });
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      URL.revokeObjectURL(url);
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("That video has no usable length."));
        return;
      }
      resolve({ width, height, duration });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That video could not be opened on this phone."));
    };
    video.src = url;
  });
}

async function loadLibrary() {
  const saved = await kvGet(libraryKey());
  if (!saved) {
    state.library = [];
    return;
  }
  const bytes = await decryptBytes(state.vaultKey, saved);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  state.library = parsed.projects || [];
  state.people = parsed.people || [];
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  if (document.querySelector(".install")) paint();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function originalPreviewUrl() {
  const clip = state.draft?.clips?.find((item) => item.kind === "video");
  if (!clip) return "";
  try {
    return URL.createObjectURL(blobFor(clip));
  } catch {
    return "";
  }
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    const target = Math.min(Math.max(time, 0), Math.max((video.duration || 1) - 0.05, 0));
    if (Math.abs((video.currentTime || 0) - target) < 0.01) {
      video.removeEventListener("seeked", done);
      resolve();
      return;
    }
    video.currentTime = target;
  });
}

function frameFromVideo(video, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}

function withVideo(file, run) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = async () => {
      try {
        resolve(await run(video));
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

function sampleFrames(file, count) {
  return withVideo(file, async (video) => {
    const frames = [];
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const long = Math.max(video.videoWidth || 320, video.videoHeight || 180);
    const scale = long > 320 ? 320 / long : 1;
    const width = Math.max(64, Math.round((video.videoWidth || 320) * scale));
    const height = Math.max(64, Math.round((video.videoHeight || 180) * scale));
    for (let i = 0; i < count; i++) {
      await seekVideo(video, duration ? (duration * (i + 1)) / (count + 1) : 0);
      frames.push(frameFromVideo(video, width, height));
    }
    return frames;
  }).then((frames) => frames || []);
}

async function applyTags(clip, file) {
  const frames = await sampleFrames(file, 4);
  if (!frames.length) return;
  let audio = null;
  if (file.size < 80 * 1024 * 1024) audio = await decodeMusicPeaks(file);
  const described = await describeFrames({ frames, audio, people: state.people });
  clip.tags = described.tags;
  clip.embedding = described.embedding;
  clip.facets = described.facets;
  clip.tagger = described.tagger;
  state.people = described.people;
}

async function sampleClipFrame(file, time) {
  return withVideo(file, async (video) => {
    await seekVideo(video, time);
    return frameFromVideo(video, 48, 27);
  });
}

async function sampleChapters(file, clip) {
  const result = await withVideo(file, async (video) => {
    const duration = Number(clip.trimOut || video.duration || clip.duration || 0);
    const start = Number(clip.trimIn || 0);
    const count = 12;
    const times = [];
    const diffs = [];
    let previous = null;
    for (let i = 0; i < count; i++) {
      const time = start + ((duration - start) * i) / Math.max(1, count - 1);
      await seekVideo(video, time);
      const frame = frameFromVideo(video, 48, 27);
      times.push(time);
      if (previous) {
        let sum = 0;
        for (let p = 0; p < frame.rgba.length; p += 4) {
          sum += Math.abs(frame.rgba[p] - previous[p]) + Math.abs(frame.rgba[p + 1] - previous[p + 1]) + Math.abs(frame.rgba[p + 2] - previous[p + 2]);
        }
        diffs.push(sum / (frame.rgba.length / 4) / (255 * 3));
      }
      previous = frame.rgba;
    }
    return detectChapters(diffs, times, 0.2);
  });
  return result || [{ time: Number(clip.trimIn || 0), title: "Scene 1" }];
}

async function decodeMusicPeaks(file) {
  if (typeof AudioContext === "undefined" || file.size > 32 * 1024 * 1024) return null;
  try {
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
    await ctx.close();
    return { samples: audio.getChannelData(0).slice(), sampleRate: audio.sampleRate };
  } catch {
    return null;
  }
}

async function boot() {
  const opening = reducedMotion() ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 800));
  try {
    state.record = await kvGet("vault");
    state.screen = state.record ? "unlock" : "setup";
  } catch {
    state.screen = "blocked";
    state.error = "This browser is blocking saved data. Leave private mode and open the app again.";
  }
  await opening;
  paint();
}

boot();

if (new URLSearchParams(location.search).has("e2e")) {
  window.__FNK = {
    renderFilm,
    sampleCorner,
    buildTimeline,
    outputSize,
    applyPreset,
    encodeCanvasFilm,
    FPS,
    RESOLUTIONS,
    screen: () => state.screen,
  };
}
