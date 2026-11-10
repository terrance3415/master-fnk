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

/** Seconds of finished film a phone render will accept. */
export const LIMITS = {
  "720": { plain: 60, enhance: 8 },
  "1080": { plain: 40, enhance: 8 },
  "2160": { plain: 20, enhance: 4 },
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
  };
}

function naturalVideoOut(clip, slowMo) {
  if (clip.kind !== "video") return 0;
  const duration = Math.max(0.25, Number(clip.duration) || 0);
  return duration * slowMo;
}

/**
 * Build a finished-film timeline. Long clips are shortened so a phone can
 * finish the render. Photos stay on screen for PHOTO_SECONDS.
 */
export function buildTimeline(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : [];
  const slowMo = [1, 2, 4].includes(options.slowMo) ? options.slowMo : 1;
  const resolution = RESOLUTIONS[options.resolution] ? options.resolution : "720";
  const enhance = Boolean(options.enhance);
  const n = list.length;
  const transition = n > 1 ? TRANSITION_SECONDS : 0;
  const cap = maxSeconds(resolution, enhance);
  if (!n) {
    return { error: "Add a video or a photo first.", segments: [], duration: 0, frameCount: 0, cap };
  }
  const photoSum = list.reduce((sum, clip) => sum + (clip.kind === "image" ? PHOTO_SECONDS : 0), 0);
  const transTotal = transition * Math.max(0, n - 1);
  const naturalVideo = list.map((clip) => naturalVideoOut(clip, slowMo));
  const naturalVideoSum = naturalVideo.reduce((sum, value) => sum + value, 0);
  const photosAlone = photoSum - transTotal;
  if (naturalVideoSum === 0 && photosAlone > cap + 1e-6) {
    return {
      error: `Photos alone would run ${photosAlone.toFixed(0)}s. This size stays under ${cap}s. Remove a photo.`,
      segments: [],
      duration: 0,
      frameCount: 0,
      cap,
    };
  }
  const allowedVideo = cap - photoSum + transTotal;
  if (naturalVideoSum > 0 && allowedVideo < 0.4) {
    return {
      error: `That is too long for ${RESOLUTIONS[resolution].label}${enhance ? " with Enhance" : ""}. Remove a clip.`,
      segments: [],
      duration: 0,
      frameCount: 0,
      cap,
    };
  }
  const scale = naturalVideoSum === 0 ? 1 : Math.min(1, allowedVideo / naturalVideoSum);
  let cursor = 0;
  const segments = list.map((clip, index) => {
    const outDuration = clip.kind === "image" ? PHOTO_SECONDS : naturalVideo[index] * scale;
    const sourceUsed = clip.kind === "image" ? 0 : outDuration / slowMo;
    const start = cursor;
    const end = start + outDuration;
    cursor = end - (index < n - 1 ? transition : 0);
    return {
      id: clip.id,
      kind: clip.kind,
      index,
      width: clip.width || 0,
      height: clip.height || 0,
      outDuration,
      sourceUsed,
      sourceDuration: clip.kind === "video" ? Number(clip.duration) || sourceUsed : 0,
      start,
      end,
      slowMo,
    };
  });
  const duration = segments.length ? segments[segments.length - 1].end : 0;
  const frameCount = Math.max(1, Math.round(duration * FPS));
  const trimmed = scale < 0.999;
  let message = "";
  if (trimmed) {
    const shown = segments
      .filter((segment) => segment.kind === "video")
      .reduce((sum, segment) => sum + segment.sourceUsed, 0);
    message = `Only the opening ${shown.toFixed(1)}s of video fit on a phone at this size. The rest is left out.`;
  }
  return {
    segments,
    duration,
    frameCount,
    transition,
    trimmed,
    message,
    cap,
    scale,
    resolution,
    enhance,
    slowMo,
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
      seg.kind === "video" && seg.outDuration > 0 ? (local / seg.outDuration) * seg.sourceUsed : 0;
    layers.push({ seg, local, alpha, sourceTime });
  }
  return layers.filter((layer) => layer.alpha > 0.02);
}

export function outputSize(resolution) {
  const item = RESOLUTIONS[resolution] || RESOLUTIONS["720"];
  if (item.width < 1280 || item.height < 720) {
    throw new Error("export size dropped under 720p");
  }
  return item;
}

/** Working picture size. 4K files are scaled up from a 1080p working picture. */
export function workSize(resolution, letterbox) {
  const out = outputSize(resolution);
  const box = letterboxRect(out.width, out.height, letterbox);
  const capW = out.width >= 3840 ? 1920 : out.width;
  const capH = out.height >= 2160 ? 1080 : out.height;
  const scale = Math.min(1, capW / box.width, capH / box.height);
  return {
    output: out,
    box,
    workWidth: even(box.width * scale),
    workHeight: even(box.height * scale),
  };
}
