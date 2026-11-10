import { encodeCanvasFilm } from "./encode.mjs";
import {
  FPS,
  PRESETS,
  RESOLUTIONS,
  applyPreset,
  buildTimeline,
  outputSize,
} from "./filmmath.mjs";
import { renderFilm, sampleCorner } from "./render.mjs";
import { kvDel, kvGet, kvSet, wipeDb } from "./store.mjs";
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

const app = document.getElementById("app");
const state = {
  screen: "working",
  working: "Opening…",
  error: "",
  record: null,
  vaultKey: null,
  pending: null,
  quiz: [],
  library: [],
  draft: null,
  blobs: new Map(),
  done: null,
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
  app.innerHTML = screens[state.screen] ? screens[state.screen]() : screens.working();
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
        <p class="note">At least ${MIN_PASSWORD} characters. You will get 12 recovery words next. They are shown once.</p>
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
    return `<h1>Master FNK</h1>
      <p class="lede">Enter the password for this phone.</p>
      ${installCard()}
      <form class="stack" data-action="unlock">
        ${field("password", "Password", "password", "required")}
        <p class="note" data-wait>${locked ? `Try again in ${esc(formatWait((until - Date.now()) / 1000))}.` : ""}</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button class="btn primary" type="submit" ${locked ? "disabled" : ""}>Unlock</button>
      </form>
      <button type="button" class="btn ghost" data-action="show-recover">Forgot the password</button>
      <button type="button" class="btn danger" data-action="show-erase">Erase the lock and films on this phone</button>`;
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
    const cards = state.library.length
      ? state.library.map((project) => `<article class="card stack">
          <strong>${esc(project.name || "Untitled film")}</strong>
          <span class="note">${esc(project.status === "ready" ? `${project.output?.width || ""}×${project.output?.height || ""} ready` : "Draft")}</span>
          <div class="row">
            <button type="button" class="btn" data-action="open-project" data-id="${esc(project.id)}">${project.status === "ready" ? "Play" : "Continue"}</button>
            <button type="button" class="btn ghost" data-action="delete-project" data-id="${esc(project.id)}">Delete</button>
          </div>
        </article>`).join("")
      : `<p class="lede">No films yet.</p>`;
    return `<header class="topbar"><h2>Your films</h2><button type="button" class="icon" data-action="lock">Lock</button></header>
      ${installCard()}
      <div class="stack">${cards}</div>
      <button type="button" class="btn primary" data-action="new-film">Make a film</button>
      <p class="footer">Saved films stay encrypted on this phone. Closing the app locks it.</p>`;
  },
  edit() {
    const draft = state.draft;
    const plan = buildTimeline(draft.clips, draft);
    const clips = draft.clips.map((clip, index) => `<div class="clip">
      <div><b>${esc(clip.name || (clip.kind === "image" ? "Photo" : "Video"))}</b><div class="note">${clip.kind === "image" ? "Photo" : `${Number(clip.duration).toFixed(1)}s`} · ${clip.width}×${clip.height}</div></div>
      <div>
        <button type="button" data-action="move-clip" data-dir="-1" data-index="${index}" aria-label="Move earlier">↑</button>
        <button type="button" data-action="move-clip" data-dir="1" data-index="${index}" aria-label="Move later">↓</button>
        <button type="button" data-action="remove-clip" data-index="${index}">Remove</button>
      </div>
    </div>`).join("");
    return `<header class="topbar"><button type="button" class="icon" data-action="show-library">Back</button><h2>New film</h2></header>
      <div class="stack">
        <label>Name on the film<input id="film-name" data-field="name" type="text" maxlength="60" value="${esc(draft.name || "")}" placeholder="Optional title"></label>
        <section class="card">
          <div class="row">
            <button type="button" class="btn" data-action="pick-media">Add video or photo</button>
            <button type="button" class="btn ghost" data-action="pick-music">${draft.music ? "Change music" : "Add music"}</button>
          </div>
          <input id="media-input" class="hidden" type="file" accept="video/*,image/*" multiple>
          <input id="music-input" class="hidden" type="file" accept="audio/*">
          ${clips || `<p class="note">Add a few clips or photos. They play in order with a soft fade between them.</p>`}
          ${draft.music ? `<p class="note">Music: ${esc(draft.music.name)}</p>` : ""}
        </section>
        <div class="looks">
          ${Object.values(PRESETS).map((preset) => `<button type="button" class="look ${draft.look === preset.id ? "on" : ""}" data-action="pick-look" data-look="${preset.id}"><i class="swatch ${preset.id}"></i><b>${esc(preset.label)}</b><span>${esc(preset.blurb)}</span></button>`).join("")}
        </div>
        <div class="chips">
          ${Object.entries(RESOLUTIONS).map(([id, item]) => `<button type="button" class="chip ${draft.resolution === id ? "on" : ""}" data-action="pick-res" data-res="${id}">${esc(item.label)}</button>`).join("")}
        </div>
        <p class="note">${esc(RESOLUTIONS[draft.resolution].hint)}</p>
        <section class="card stack">
          ${slider("denoise", "Denoise", draft.denoise)}
          ${slider("sharpen", "Sharpen", draft.sharpen)}
          ${slider("grain", "Film grain", draft.grain)}
          <div class="chips" aria-label="Slow motion">
            ${[1, 2, 4].map((value) => `<button type="button" class="chip ${draft.slowMo === value ? "on" : ""}" data-action="pick-slow" data-slow="${value}">${value === 1 ? "Normal" : `${value}× slow`}</button>`).join("")}
          </div>
          <label class="check"><input type="checkbox" data-field="letterbox" ${draft.letterbox ? "checked" : ""}> Wide movie bars (2.39:1)</label>
          <label class="check"><input type="checkbox" data-field="enhance" ${draft.enhance ? "checked" : ""}> Enhance small clips up to 720p</label>
          <p class="note">Enhance rebuilds detail on clips under 720p. It is slow. The first time, this phone downloads about 20 MB, or about 35 MB if the graphics chip can help.</p>
        </section>
        <p class="note plan">${plan.error ? esc(plan.error) : `${plan.duration.toFixed(1)}s · ${plan.frameCount} frames · ${esc(RESOLUTIONS[draft.resolution].label)}${plan.message ? ` · ${esc(plan.message)}` : ""}`}</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
        <button type="button" class="btn primary" data-action="create-film" ${plan.error || !draft.clips.length ? "disabled" : ""}>Create video</button>
      </div>`;
  },
  render() {
    return `<h1>Creating</h1>
      <p data-progress-label class="lede">${esc(state.working || "Starting…")}</p>
      <div class="progress" aria-hidden="true"><span data-progress-bar></span></div>
      <p class="note">Keep this screen open. A longer film, 1080p, or Enhance takes longer. 4K is the slowest.</p>
      <button type="button" class="btn ghost" data-action="cancel-render">Stop</button>`;
  },
  done() {
    const done = state.done || {};
    return `<header class="topbar"><button type="button" class="icon" data-action="show-library">Films</button><h2>Ready</h2></header>
      <video class="preview" controls playsinline src="${done.url || ""}"></video>
      <p><b>${esc(done.width)}×${esc(done.height)}</b> · ${Number(done.duration || 0).toFixed(1)}s · H.264</p>
      ${(done.notes || []).map((note) => `<p class="note">${esc(note)}</p>`).join("")}
      <div class="row">
        <button type="button" class="btn primary" data-action="download">Download</button>
        <button type="button" class="btn ghost" data-action="new-film">Make another</button>
      </div>
      <p class="footer">Saved in the vault on this phone. Download keeps a copy in your gallery or files.</p>`;
  },
};

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
    clips: project.clips.map((clip) => ({
      id: clip.id,
      kind: clip.kind,
      name: clip.name,
      duration: clip.duration,
      width: clip.width,
      height: clip.height,
      type: clip.type,
      fileId: clip.fileId,
    })),
    music: project.music
      ? { name: project.music.name, type: project.music.type, fileId: project.music.fileId }
      : null,
    output: project.output || null,
    updatedAt: Date.now(),
  };
}

async function persist() {
  const payload = new TextEncoder().encode(JSON.stringify({ projects: state.library.map(serializable) }));
  const enc = await encryptBytes(state.vaultKey, payload);
  await kvSet("library", { iv: enc.iv, ct: enc.ct });
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
    clips: [],
    music: null,
    output: null,
  };
}

async function rememberFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const enc = await encryptBytes(state.vaultKey, bytes);
  const fileId = crypto.randomUUID();
  await kvSet(`file:${fileId}`, { iv: enc.iv, ct: enc.ct });
  state.blobs.set(fileId, file);
  return fileId;
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
    const saved = await kvGet(`file:${fileId}`);
    if (!saved) continue;
    const bytes = await decryptBytes(state.vaultKey, saved);
    const meta = project.clips.find((clip) => clip.fileId === fileId) || project.music || {};
    const type = meta.type || (project.output?.fileId === fileId ? "video/mp4" : "");
    state.blobs.set(fileId, new Blob([bytes], { type }));
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
  lock() {
    if (state.vaultKey) state.vaultKey.fill(0);
    state.vaultKey = null;
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
    if (clip) {
      state.blobs.delete(clip.fileId);
      await kvDel(`file:${clip.fileId}`);
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
      await kvDel(`file:${fileId}`);
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
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const enc = await encryptBytes(state.vaultKey, bytes);
      const fileId = crypto.randomUUID();
      await kvSet(`file:${fileId}`, { iv: enc.iv, ct: enc.ct });
      state.blobs.set(fileId, result.blob);
      state.draft.status = "ready";
      state.draft.output = {
        fileId,
        width: result.width,
        height: result.height,
        duration: result.duration,
        bytes: bytes.length,
      };
      await saveDraft();
      state.done = {
        url: URL.createObjectURL(result.blob),
        width: result.width,
        height: result.height,
        duration: result.duration,
        notes: result.notes,
        filename: fileName(state.draft.name),
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
    if (input.type === "range") state.draft[input.dataset.field] = Number(input.value) / 100;
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
      state.pending = await createVault(password, phrase, PRODUCTION_SCRYPT);
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
    state.blobs.clear();
    await wipeDb();
    state.record = null;
    state.library = [];
    state.screen = "setup";
    paint();
  }
});

app.addEventListener("input", (event) => {
  if (!state.draft) return;
  const input = event.target;
  if (input.id === "film-name") state.draft.name = input.value;
  if (input.dataset.field === "denoise" || input.dataset.field === "sharpen" || input.dataset.field === "grain") {
    state.draft[input.dataset.field] = Number(input.value) / 100;
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

app.addEventListener("change", async (event) => {
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
        state.draft.clips.push({
          id: crypto.randomUUID(),
          kind,
          name: file.name,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          type: file.type,
          fileId,
        });
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
  const saved = await kvGet("library");
  if (!saved) {
    state.library = [];
    return;
  }
  const bytes = await decryptBytes(state.vaultKey, saved);
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  state.library = parsed.projects || [];
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  if (document.querySelector(".install")) paint();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

async function boot() {
  try {
    state.record = await kvGet("vault");
    state.screen = state.record ? "unlock" : "setup";
  } catch {
    state.screen = "blocked";
    state.error = "This browser is blocking saved data. Leave private mode and open the app again.";
  }
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
