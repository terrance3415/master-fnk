/**
 * Phone render. Every export is at least 720p.
 * Enhance runs the compact Real-ESRGAN model on a small frame (about 720p of
 * detail). 1080p is drawn at 1080p when Enhance is off. 4K is a 1080p picture
 * scaled up, with titles drawn at the full size.
 */
import { encodeCanvasFilm } from "./encode.mjs";
import { FPS, GRADES, layersAt, letterboxRect, outputSize, workSize } from "./filmmath.mjs";
import { denoiseRGBA, estimateShift, grayscale, isSceneCut, sharpenRGBA } from "./process.mjs";
import { neuralInputSize, openEnhancer, upscaleRgb } from "./upscale.mjs";

const NEURAL_LONG = 320;
const NEURAL_TILE = 192;
const NEURAL_OVERLAP = 16;
const SCENE_THRESHOLD = 0.3;

function once(target, event) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("Could not read that clip."));
    };
    const cleanup = () => {
      target.removeEventListener(event, ok);
      target.removeEventListener("error", bad);
    };
    target.addEventListener(event, ok);
    target.addEventListener("error", bad);
  });
}

async function seek(video, time) {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const target = Math.min(Math.max(time, 0), Math.max(duration - 0.04, 0));
  if (Math.abs(video.currentTime - target) < 0.001) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      video.removeEventListener("seeked", done);
      resolve();
    }, 2500);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    video.addEventListener("seeked", done, { once: true });
    try {
      video.currentTime = target;
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function loadMedia(clip) {
  const url = URL.createObjectURL(clip.blob);
  if (clip.kind === "image") {
    const image = new Image();
    image.src = url;
    if (image.decode) await image.decode();
    else await once(image, "load");
    return { ...clip, url, image, video: null };
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await once(video, "loadeddata");
  video.pause();
  return { ...clip, url, image: null, video };
}

export function releaseMedia(items) {
  for (const item of items || []) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
}

function coverDraw(ctx, source, sw, sh, dw, dh, zoom, panX) {
  const scale = Math.max(dw / sw, dh / sh) * zoom;
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2 + panX * dw, (dh - h) / 2, w, h);
}

function containDraw(ctx, source, sw, sh, dw, dh, zoom) {
  const scale = Math.min(dw / sw, dh / sh) * zoom;
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2, (dh - h) / 2, w, h);
}

function paintSource(ctx, source, sw, sh, dw, dh, gradeName, zoom, panX) {
  const grade = GRADES[gradeName] || GRADES.movie;
  const portrait = sh / sw > 1.05;
  ctx.clearRect(0, 0, dw, dh);
  if (portrait) {
    ctx.filter = `blur(16px) brightness(0.72) ${grade.filter}`;
    coverDraw(ctx, source, sw, sh, dw, dh, 1.15, 0);
    ctx.filter = grade.filter;
    containDraw(ctx, source, sw, sh, dw, dh, zoom);
  } else {
    ctx.filter = grade.filter;
    coverDraw(ctx, source, sw, sh, dw, dh, zoom, panX);
  }
  ctx.filter = "none";
}

function canvasToRgb(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 3) {
    rgb[p] = image.data[i];
    rgb[p + 1] = image.data[i + 1];
    rgb[p + 2] = image.data[i + 2];
  }
  return rgb;
}

function rgbToCanvas(rgb, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let i = 0, p = 0; p < rgb.length; i += 4, p += 3) {
    image.data[i] = rgb[p];
    image.data[i + 1] = rgb[p + 1];
    image.data[i + 2] = rgb[p + 2];
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function enhanceSource(media, sourceTime, project, tools) {
  const key = `${media.id}|${Math.round(sourceTime * 8) / 8}`;
  if (tools.cache.has(key)) return tools.cache.get(key);
  const size = neuralInputSize(media.width, media.height, NEURAL_LONG);
  const small = tools.small;
  small.width = size.width;
  small.height = size.height;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (media.video) await seek(media.video, sourceTime);
  const source = media.video || media.image;
  ctx.drawImage(source, 0, 0, size.width, size.height);
  if (project.denoise > 0) {
    const image = ctx.getImageData(0, 0, size.width, size.height);
    const denoised = denoiseRGBA(image.data, size.width, size.height, project.denoise);
    image.data.set(denoised);
    ctx.putImageData(image, 0, 0);
  }
  const rgb = canvasToRgb(small);
  const enhanceStarted = performance.now();
  const up = await upscaleRgb(tools.ort, tools.enhancer.session, rgb, size.width, size.height, {
    tile: NEURAL_TILE,
    overlap: NEURAL_OVERLAP,
    modelScale: 4,
    targetScale: 4,
    onTile: () => tools.onTile && tools.onTile(),
  });
  const picture = rgbToCanvas(up.rgb, up.width, up.height);
  tools.cache.set(key, picture);
  if (tools.cache.size > 8) {
    const oldest = tools.cache.keys().next().value;
    tools.cache.delete(oldest);
  }
  tools.enhancedFrames += 1;
  tools.enhanceMs += performance.now() - enhanceStarted;
  return picture;
}

function stabilize(work, tools) {
  const probe = tools.probe;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(work, 0, 0, probe.width, probe.height);
  const image = ctx.getImageData(0, 0, probe.width, probe.height);
  const gray = grayscale(image.data, probe.width, probe.height);
  let dx = 0;
  let dy = 0;
  if (tools.prevGray && !isSceneCut(tools.prevRGBA, image.data, SCENE_THRESHOLD)) {
    const shift = estimateShift(tools.prevGray, gray, probe.width, probe.height, 4);
    const smooth = 0.65;
    dx = tools.prevShift.dx * smooth + shift.dx * (1 - smooth);
    dy = tools.prevShift.dy * smooth + shift.dy * (1 - smooth);
  } else {
    tools.prevShift = { dx: 0, dy: 0 };
  }
  tools.prevGray = gray;
  tools.prevRGBA = image.data;
  tools.prevShift = { dx, dy };
  const scaleX = work.width / probe.width;
  return { x: -dx * scaleX, y: -dy * (work.height / probe.height) };
}

async function drawLayer(work, media, project, layer, tools) {
  const zoom = media.kind === "image" ? 1 + 0.08 * (layer.local / Math.max(0.001, layer.seg.outDuration)) : 1;
  const pan = media.kind === "image" ? (layer.local / Math.max(0.001, layer.seg.outDuration) - 0.5) * 0.04 : 0;
  let source = media.video || media.image;
  let sw = media.width;
  let sh = media.height;
  if (media.video && !tools.enhancing) await seek(media.video, layer.sourceTime);
  if (tools.enhancing && media.kind === "video" && Math.max(media.width, media.height) < 1280) {
    const picture = await enhanceSource(media, layer.sourceTime, project, tools);
    source = picture;
    sw = picture.width;
    sh = picture.height;
  } else if (tools.enhancing && media.kind === "image" && Math.max(media.width, media.height) < 1280) {
    const picture = await enhanceSource(media, 0, project, tools);
    source = picture;
    sw = picture.width;
    sh = picture.height;
  }
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  paintSource(ctx, source, sw, sh, work.width, work.height, project.grade, zoom, pan);
  if (!tools.enhancing && project.denoise > 0) {
    const image = ctx.getImageData(0, 0, work.width, work.height);
    image.data.set(denoiseRGBA(image.data, work.width, work.height, project.denoise));
    ctx.putImageData(image, 0, 0);
  }
  const shift = stabilize(work, tools);
  if (Math.abs(shift.x) + Math.abs(shift.y) > 0.4) {
    const snapshot = document.createElement("canvas");
    snapshot.width = work.width;
    snapshot.height = work.height;
    snapshot.getContext("2d").drawImage(work, 0, 0);
    ctx.clearRect(0, 0, work.width, work.height);
    ctx.drawImage(snapshot, shift.x, shift.y);
  }
  if (project.sharpen > 0) {
    const image = ctx.getImageData(0, 0, work.width, work.height);
    image.data.set(sharpenRGBA(image.data, work.width, work.height, project.sharpen));
    ctx.putImageData(image, 0, 0);
  }
}

function grainTile() {
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(180, 180);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 90 + Math.floor(Math.random() * 80);
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function applyFinish(ctx, project, box, frameIndex, grain) {
  const grade = GRADES[project.grade] || GRADES.clean;
  if (grade.washTop || grade.washBottom) {
    const wash = ctx.createLinearGradient(0, box.y, 0, box.y + box.height);
    wash.addColorStop(0, grade.washTop || "rgba(0,0,0,0)");
    wash.addColorStop(0.5, "rgba(0,0,0,0)");
    wash.addColorStop(1, grade.washBottom || "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = wash;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }
  if (project.grain > 0 && grain) {
    ctx.save();
    ctx.globalAlpha = 0.18 + project.grain * 0.35;
    ctx.globalCompositeOperation = "overlay";
    const shift = (frameIndex * 17) % 180;
    ctx.drawImage(grain, box.x - shift, box.y - ((frameIndex * 11) % 180), box.width + 180, box.height + 180);
    ctx.restore();
  }
  if (project.vignette > 0) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const radius = Math.hypot(box.width, box.height) / 2;
    const vignette = ctx.createRadialGradient(cx, cy, radius * 0.45, cx, cy, radius * 0.95);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, `rgba(0,0,0,${project.vignette})`);
    ctx.fillStyle = vignette;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }
}

function drawTitle(ctx, project, box, time) {
  const title = (project.openingTitle || "").trim();
  if (!title || time > 4.4) return;
  let alpha = 1;
  if (time < 0.45) alpha = time / 0.45;
  else if (time > 3.4) alpha = Math.max(0, (4.4 - time) / 1);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#f6f0e4";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 16;
  let size = Math.round(box.width * 0.062);
  const maxWidth = box.width * 0.86;
  ctx.font = `600 ${size}px Georgia, "Times New Roman", serif`;
  while (ctx.measureText(title).width > maxWidth && size > 22) {
    size -= 2;
    ctx.font = `600 ${size}px Georgia, "Times New Roman", serif`;
  }
  ctx.fillText(title, box.x + box.width / 2, box.y + box.height * 0.78);
  ctx.restore();
}

async function compose(output, work, layers, mediaById, project, tools, frameIndex, time) {
  const ctx = output.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, output.width, output.height);
  const box = letterboxRect(output.width, output.height, project.letterbox);
  let first = true;
  for (const layer of layers) {
    const media = mediaById.get(layer.seg.id);
    if (!media) continue;
    tools.enhancing =
      project.enhance &&
      ((media.kind === "video" && Math.max(media.width, media.height) < 1280) ||
        (media.kind === "image" && Math.max(media.width, media.height) < 1280));
    if (project.slowMo > 1 && media.video && !tools.enhancing) {
      const step = 1 / 30;
      const t1 = Math.min(layer.seg.sourceUsed, layer.sourceTime + step);
      await drawLayer(work, media, project, { ...layer, sourceTime: layer.sourceTime }, tools);
      const a = document.createElement("canvas");
      a.width = work.width;
      a.height = work.height;
      a.getContext("2d").drawImage(work, 0, 0);
      await drawLayer(work, media, project, { ...layer, sourceTime: t1 }, tools);
      const wctx = work.getContext("2d");
      wctx.globalAlpha = 0.45;
      wctx.drawImage(a, 0, 0);
      wctx.globalAlpha = 1;
    } else {
      await drawLayer(work, media, project, layer, tools);
    }
    ctx.globalAlpha = first ? 1 : layer.alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(work, box.x, box.y, box.width, box.height);
    ctx.globalAlpha = 1;
    first = false;
  }
  applyFinish(ctx, project, box, frameIndex, tools.grain);
  if (project.letterbox) {
    ctx.fillStyle = "#000";
    if (box.y > 0) ctx.fillRect(0, 0, output.width, box.y);
    const bottom = box.y + box.height;
    if (bottom < output.height) ctx.fillRect(0, bottom, output.width, output.height - bottom);
  }
  drawTitle(ctx, project, box, time);
}

async function ensureEnhancer(project, media, tools) {
  const needs = project.enhance && media.some((item) => Math.max(item.width, item.height) < 1280);
  if (!needs) return;
  if (!tools.enhancer) {
    const ort = globalThis.ort;
    const modelUrl = new URL("models/realesr-general-x4v3.onnx", document.baseURI).href;
    tools.enhancer = await openEnhancer(ort, modelUrl);
    tools.backend = tools.enhancer.backend;
  }
}

export async function renderFilm(project, timeline, options = {}) {
  const started = performance.now();
  const size = outputSize(project.resolution);
  const geometry = workSize(project.resolution, project.letterbox);
  const output = document.createElement("canvas");
  output.width = size.width;
  output.height = size.height;
  const work = document.createElement("canvas");
  work.width = geometry.workWidth;
  work.height = geometry.workHeight;
  const media = [];
  for (const clip of project.clips) {
    const loaded = await loadMedia(clip);
    loaded.width = loaded.video ? loaded.video.videoWidth : loaded.image.naturalWidth;
    loaded.height = loaded.video ? loaded.video.videoHeight : loaded.image.naturalHeight;
    media.push(loaded);
  }
  const mediaById = new Map(media.map((item) => [item.id, item]));
  const tools = {
    enhancer: null,
    ort: globalThis.ort,
    cache: new Map(),
    small: document.createElement("canvas"),
    probe: Object.assign(document.createElement("canvas"), { width: 96, height: 54 }),
    prevGray: null,
    prevRGBA: null,
    prevShift: { dx: 0, dy: 0 },
    grain: grainTile(),
    enhancedFrames: 0,
    enhanceMs: 0,
    backend: "none",
    enhancing: false,
    onTile: options.onTile,
  };
  const notes = [];
  if (project.enhance) {
    const skipped = media.filter((item) => Math.max(item.width, item.height) >= 1280);
    if (skipped.length) notes.push("Clips already 720p or larger were sharpened instead of rebuilt.");
    await ensureEnhancer(project, media, tools);
    if (tools.backend === "wasm") notes.push("Enhance ran on the phone’s processor (no WebGPU).");
    if (tools.backend === "webgpu") notes.push("Enhance used WebGPU on this phone.");
  }
  if (project.resolution === "2160") {
    notes.push("4K file. The picture is a sharp scale-up of a 1080p working image.");
  }
  const frameCount = Math.max(1, Math.min(timeline.frameCount, options.maxFrames || timeline.frameCount));
  let audioBuffer = null;
  if (project.music && project.music.blob) {
    try {
      const ctx = new AudioContext();
      const copy = (await project.music.blob.arrayBuffer()).slice(0);
      audioBuffer = await ctx.decodeAudioData(copy);
      await ctx.close();
    } catch {
      notes.push("The music file could not be read. The film has no soundtrack.");
    }
  }
  try {
    const encoded = await encodeCanvasFilm({
      canvas: output,
      fps: FPS,
      bitrate: size.bitrate,
      frameCount,
      audioBuffer,
      signal: options.signal,
      draw: async (index) => {
        const time = Math.min(timeline.duration - 1e-3, index / FPS);
        const layers = layersAt(timeline, time);
        if (options.onProgress) {
          options.onProgress({
            frame: index + 1,
            total: frameCount,
            label: project.enhance
              ? `Building frame ${index + 1} of ${frameCount}`
              : `Coloring frame ${index + 1} of ${frameCount}`,
          });
        }
        await compose(output, work, layers, mediaById, project, tools, index, time);
      },
    });
    if (encoded.audio === "music-skipped" && project.music) notes.push("Music could not be attached in this browser.");
    if (encoded.audio === "aac" || encoded.audio === "opus") notes.push("Music is mixed into the film.");
    const ms = performance.now() - started;
    return {
      ...encoded,
      duration: frameCount / FPS,
      ms,
      backend: tools.backend,
      enhancedFrames: tools.enhancedFrames,
      enhanceMs: Math.round(tools.enhanceMs),
      notes,
      workWidth: geometry.workWidth,
      workHeight: geometry.workHeight,
    };
  } finally {
    if (tools.enhancer?.session?.release) {
      try {
        await tools.enhancer.session.release();
      } catch {
        /* closing */
      }
    }
    releaseMedia(media);
  }
}

export async function sampleCorner(project, timeline) {
  const size = outputSize(project.resolution);
  const geometry = workSize(project.resolution, project.letterbox);
  const output = document.createElement("canvas");
  output.width = size.width;
  output.height = size.height;
  const work = document.createElement("canvas");
  work.width = geometry.workWidth;
  work.height = geometry.workHeight;
  const media = [];
  for (const clip of project.clips) media.push(await loadMedia(clip));
  for (const item of media) {
    item.width = item.video ? item.video.videoWidth : item.image.naturalWidth;
    item.height = item.video ? item.video.videoHeight : item.image.naturalHeight;
  }
  const tools = {
    enhancer: null,
    ort: globalThis.ort,
    cache: new Map(),
    small: document.createElement("canvas"),
    probe: Object.assign(document.createElement("canvas"), { width: 96, height: 54 }),
    prevGray: null,
    prevRGBA: null,
    prevShift: { dx: 0, dy: 0 },
    grain: grainTile(),
    enhancedFrames: 0,
    backend: "none",
    enhancing: false,
  };
  const mediaById = new Map(media.map((item) => [item.id, item]));
  await compose(output, work, layersAt(timeline, 0.2), mediaById, project, tools, 4, 0.2);
  const ctx = output.getContext("2d");
  const corner = ctx.getImageData(2, 2, 1, 1).data;
  const center = ctx.getImageData(Math.floor(size.width / 2), Math.floor(size.height / 2), 1, 1).data;
  releaseMedia(media);
  return {
    width: size.width,
    height: size.height,
    corner: [corner[0], corner[1], corner[2]],
    center: [center[0], center[1], center[2]],
  };
}
