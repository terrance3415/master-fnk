/** Timeline, sizes, and looks for the phone studio. No browser APIs. */

export const FPS = 24;
export const TRANSITION_SECONDS = 0.45;
export const PHOTO_SECONDS = 3;
export const LETTERBOX_RATIO = 2.39;

export const RESOLUTIONS = {
  "720": {
    width: 1280,
    height: 720,
    bitrate: 5_000_000,
    label: "720p",
    hint: "Standard size. The reliable choice on a phone.",
  },
  "1080": {
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    label: "1080p",
    hint: "Sharper. Takes longer to build.",
  },
  "2160": {
    width: 3840,
    height: 2160,
    bitrate: 16_000_000,
    label: "4K",
    hint: "Largest file. The picture is built at 1080p and scaled up. Titles stay sharp.",
  },
};

/** Seconds of finished film a phone render will accept. Plain caps are longer; Enhance stays short. */
export const LIMITS = {
  "720": { plain: 180, enhance: 8 },
  "1080": { plain: 90, enhance: 8 },
  "2160": { plain: 40, enhance: 4 },
};

export const ASPECTS = {
  "16:9": {
    "720": [1280, 720],
    "1080": [1920, 1080],
    "2160": [3840, 2160],
  },
  "9:16": {
    "720": [720, 1280],
    "1080": [1080, 1920],
    "2160": [2160, 3840],
  },
  "1:1": {
    "720": [1080, 1080],
    "1080": [1440, 1440],
    "2160": [2160, 2160],
  },
};

export const GRADES = {
  movie: {
    filter: "contrast(1.12) saturate(0.88) brightness(1.03)",
    washTop: "rgba(255, 176, 90, 0.30)",
    washBottom: "rgba(0, 72, 82, 0.40)",
  },
  vintage: {
    filter: "sepia(0.42) contrast(0.93) saturate(0.7) brightness(1.07)",
    washTop: "rgba(255, 214, 160, 0.22)",
    washBottom: "rgba(90, 52, 24, 0.28)",
  },
  dramatic: {
    filter: "contrast(1.28) saturate(1.14) brightness(0.95)",
    washTop: "rgba(255, 120, 48, 0.42)",
    washBottom: "rgba(0, 96, 118, 0.52)",
  },
  clean: {
    filter: "contrast(1.05) saturate(1.03) brightness(1.01)",
    washTop: null,
    washBottom: null,
  },
};

export const PRESETS = {
  movie: {
    id: "movie",
    label: "Movie",
    blurb: "Wide screen, warm highlights, light grain",
    letterbox: true,
    grain: 0.22,
    denoise: 0.15,
    sharpen: 0.18,
    enhance: false,
    vignette: 0.45,
    grade: "movie",
    cinematic: 0,
  },
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    blurb: "Teal shadows, orange highlights, lifted blacks",
    letterbox: true,
    grain: 0.18,
    denoise: 0.12,
    sharpen: 0.16,
    enhance: false,
    vignette: 0.5,
    grade: "movie",
    cinematic: 0.8,
  },
  vintage: {
    id: "vintage",
    label: "Vintage film",
    blurb: "Faded color and heavier grain",
    letterbox: true,
    grain: 0.5,
    denoise: 0.22,
    sharpen: 0.08,
    enhance: false,
    vignette: 0.38,
    grade: "vintage",
    cinematic: 0,
  },
  dramatic: {
    id: "dramatic",
    label: "Dramatic",
    blurb: "Deep contrast and teal shadows",
    letterbox: true,
    grain: 0.14,
    denoise: 0.1,
    sharpen: 0.28,
    enhance: false,
    vignette: 0.62,
    grade: "dramatic",
    cinematic: 0,
  },
  clean: {
    id: "clean",
    label: "Clean remaster",
    blurb: "Quieter picture, sharper edges, rebuilt detail",
    letterbox: false,
    grain: 0,
    denoise: 0.28,
    sharpen: 0.24,
    enhance: true,
    vignette: 0.08,
    grade: "clean",
    cinematic: 0,
  },
};

export function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export function even(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

export function maxSeconds(resolution, enhance) {
  const row = LIMITS[resolution] || LIMITS["720"];
  return enhance ? row.enhance : row.plain;
}

export function letterboxRect(width, height, enabled) {
  if (!enabled) return { x: 0, y: 0, width, height, bar: 0 };
  let contentH = Math.round(width / LETTERBOX_RATIO);
  contentH -= contentH % 2;
  if (contentH > height) contentH = height - (height % 2);
  const bar = Math.floor((height - contentH) / 2);
  return { x: 0, y: bar, width, height: height - bar * 2, bar };
}

export function applyPreset(id) {
  const preset = PRESETS[id] || PRESETS.movie;
  return {
    look: preset.id,
    letterbox: preset.letterbox,
    grain: preset.grain,
    denoise: preset.denoise,
    sharpen: preset.sharpen,
    enhance: preset.enhance,
    slowMo: 1,
    vignette: preset.vignette,
    grade: preset.grade,
    cinematic: preset.cinematic || 0,
  };
}

export function sourceRanges(clip) {
  if (!clip || clip.kind !== "video") return [{ start: 0, end: 0 }];
  const duration = Math.max(0, Number(clip.duration) || 0);
  let inn = Number(clip.trimIn);
  let out = Number(clip.trimOut);
  if (!Number.isFinite(inn) || inn < 0) inn = 0;
  if (!Number.isFinite(out) || out <= inn) out = duration || inn + 0.25;
  inn = Math.min(inn, Math.max(0, (duration || out) - 0.05));
  out = Math.min(duration || out, Math.max(out, inn + 0.05));
  const cutIn = Number(clip.cutIn);
  const cutOut = Number(clip.cutOut);
  if (!(Number.isFinite(cutIn) && Number.isFinite(cutOut) && cutOut > cutIn + 0.04)) {
    return [{ start: inn, end: out }];
  }
  const a = Math.min(Math.max(cutIn, inn), out);
  const b = Math.min(Math.max(cutOut, a), out);
  const parts = [];
  if (a - inn >= 0.05) parts.push({ start: inn, end: a });
  if (out - b >= 0.05) parts.push({ start: b, end: out });
  if (!parts.length) parts.push({ start: inn, end: Math.min(out, inn + 0.05) });
  return parts;
}

export function insertClipAt(clips, hostIndex, incomingIndex, atSourceTime) {
  const copy = clips.map((clip) => ({ ...clip }));
  if (hostIndex === incomingIndex) return copy;
  const host = copy[hostIndex];
  const incoming = copy[incomingIndex];
  if (!host || !incoming || host.kind !== "video") return copy;
  const ranges = sourceRanges(host);
  const spanStart = ranges[0].start;
  const spanEnd = ranges[ranges.length - 1].end;
  const at = Math.min(Math.max(Number(atSourceTime) || 0, spanStart + 0.05), spanEnd - 0.05);
  if (!(at > spanStart && at < spanEnd)) return copy;
  const left = { ...host, id: `${host.id}-a`, trimIn: spanStart, trimOut: at, cutIn: null, cutOut: null };
  const right = { ...host, id: `${host.id}-b`, trimIn: at, trimOut: spanEnd, cutIn: null, cutOut: null };
  const next = [];
  copy.forEach((clip, index) => {
    if (index === incomingIndex) return;
    if (index === hostIndex) {
      next.push(left, { ...incoming }, right);
      return;
    }
    next.push(clip);
  });
  return next;
}

function piecesOf(clip, slowMo) {
  if (clip.kind !== "video") {
    return [{ sourceStart: 0, sourceUsed: 0, outDuration: PHOTO_SECONDS, clip }];
  }
  return sourceRanges(clip).map((range) => {
    const sourceUsed = Math.max(0.05, range.end - range.start);
    return { sourceStart: range.start, sourceUsed, outDuration: sourceUsed * slowMo, clip };
  });
}

function nearestBeat(time, beats, maxDelta) {
  let best = time;
  let bestDist = maxDelta;
  for (const beat of beats || []) {
    const dist = Math.abs(beat - time);
    if (dist <= bestDist) {
      best = beat;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Build a finished-film timeline from the trims you set.
 * A film that is still over the phone cap is refused instead of keeping only the opening.
 */
export function buildTimeline(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : [];
  const slowMo = [1, 2, 4].includes(options.slowMo) ? options.slowMo : 1;
  const resolution = RESOLUTIONS[options.resolution] ? options.resolution : "720";
  const enhance = Boolean(options.enhance);
  const cap = maxSeconds(resolution, enhance);
  const pieces = list.flatMap((clip) => piecesOf(clip, slowMo));
  const n = pieces.length;
  const transition = n > 1 ? TRANSITION_SECONDS : 0;
  if (!list.length) {
    return { error: "Add a video or a photo first.", segments: [], duration: 0, frameCount: 0, cap };
  }
  let cursor = 0;
  const segments = pieces.map((piece, index) => {
    let outDuration = piece.outDuration;
    const start = cursor;
    let end = start + outDuration;
    if (options.beatSync && options.beats?.length && index < n - 1) {
      const snapped = nearestBeat(end, options.beats, 0.15);
      if (snapped - start >= 0.2) {
        end = snapped;
        outDuration = end - start;
      }
    }
    cursor = end - (index < n - 1 ? transition : 0);
    const clip = piece.clip;
    return {
      id: clip.id,
      kind: clip.kind,
      index,
      clipIndex: list.indexOf(clip),
      width: clip.width || 0,
      height: clip.height || 0,
      outDuration,
      sourceStart: piece.sourceStart,
      sourceUsed: piece.kind === "image" || clip.kind === "image" ? 0 : outDuration / slowMo,
      sourceDuration: clip.kind === "video" ? Number(clip.duration) || 0 : 0,
      start,
      end,
      slowMo,
    };
  });
  for (const segment of segments) {
    if (segment.kind === "video") segment.sourceUsed = segment.outDuration / slowMo;
  }
  const duration = segments.length ? segments[segments.length - 1].end : 0;
  if (duration > cap + 0.05) {
    return {
      error: `This film would run ${duration.toFixed(0)}s. ${RESOLUTIONS[resolution].label}${enhance ? " with Enhance" : ""} stays under ${cap}s. Trim a clip or remove one.`,
      segments: [],
      duration: 0,
      frameCount: 0,
      cap,
    };
  }
  const frameCount = Math.max(1, Math.round(duration * FPS));
  const userTrimmed = list.some((clip) => clip.kind === "video" && sourceRanges(clip).some((range) => range.end - range.start < (Number(clip.duration) || 0) - 0.05));
  return {
    segments,
    duration,
    frameCount,
    transition,
    trimmed: userTrimmed,
    message: userTrimmed ? "Using the start, end, and cuts you set." : "",
    cap,
    scale: 1,
    resolution,
    enhance,
    slowMo,
    aspect: ASPECTS[options.aspect] ? options.aspect : "16:9",
  };
}

export function layersAt(timeline, time) {
  const layers = [];
  const stamps = Math.min(Math.max(time, 0), Math.max(0, timeline.duration - 1e-4));
  for (const seg of timeline.segments) {
    if (stamps < seg.start || stamps >= seg.end) continue;
    const local = stamps - seg.start;
    let alpha = 1;
    if (seg.index > 0 && timeline.transition > 0 && local < timeline.transition) {
      alpha = local / timeline.transition;
    }
    const sourceTime =
      seg.kind === "video" && seg.outDuration > 0
        ? (seg.sourceStart || 0) + (local / seg.outDuration) * seg.sourceUsed
        : 0;
    layers.push({ seg, local, alpha, sourceTime });
  }
  return layers.filter((layer) => layer.alpha > 0.02);
}

export function outputSize(resolution, aspect = "16:9") {
  const table = ASPECTS[aspect] || ASPECTS["16:9"];
  const pair = table[resolution] || table["720"];
  const preset = RESOLUTIONS[resolution] || RESOLUTIONS["720"];
  const width = pair[0];
  const height = pair[1];
  if (Math.min(width, height) < 720) throw new Error("export size dropped under 720p");
  return { ...preset, width, height, label: `${preset.label} ${aspect}` };
}

/** Working picture size. 4K files are scaled up from a 1080p working picture. */
export function workSize(resolution, letterbox, aspect = "16:9") {
  const out = outputSize(resolution, aspect);
  const box = letterboxRect(out.width, out.height, letterbox);
  const wide = aspect === "16:9" || !aspect;
  const capW = wide ? (out.width >= 3840 ? 1920 : out.width) : Math.min(out.width, 1920);
  const capH = wide ? (out.height >= 2160 ? 1080 : out.height) : Math.min(out.height, 1920);
  const scale = Math.min(1, capW / box.width, capH / box.height);
  return {
    output: out,
    box,
    workWidth: even(box.width * scale),
    workHeight: even(box.height * scale),
  };
}
