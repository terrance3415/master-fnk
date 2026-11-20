/**
 * On-device tags from sampled frames.
 * This is a fixed vocabulary scored against color and layout measurements.
 * It does not upload frames. A neural CLIP weight file is not bundled.
 */

export const TAG_LAYERS = ["scene", "setting", "subject", "activity", "lighting", "mood"];

const VOCAB = [
  ["blue sky", "scene", (f) => f.skyBlue],
  ["cloud", "scene", (f) => f.skyWhite],
  ["sunset", "scene", (f) => f.warmSky * f.lowSun],
  ["night", "scene", (f) => f.dark * (1 - f.indoor)],
  ["beach", "setting", (f) => f.sand * f.skyBlue * 1.3],
  ["indoor", "setting", (f) => f.indoor],
  ["outdoor", "setting", (f) => 1 - f.indoor],
  ["street", "setting", (f) => f.grayGround * f.edge],
  ["car", "subject", (f) => f.edge * f.grayGround * (1 - f.green)],
  ["crowd", "subject", (f) => f.edge * f.detail * (f.skin + 0.2)],
  ["person", "subject", (f) => f.skin * (0.4 + f.detail)],
  ["water", "subject", (f) => f.water],
  ["tree", "subject", (f) => f.green * f.skyBlue],
  ["food", "subject", (f) => f.warm * f.indoor * (1 - f.skyBlue)],
  ["walking", "activity", (f) => f.edge * (1 - f.indoor) * 0.8],
  ["sitting", "activity", (f) => f.indoor * (1 - f.edge) * 0.7],
  ["driving", "activity", (f) => f.grayGround * f.edge * f.dark * 0.5 + f.grayGround * f.edge * 0.4],
  ["daylight", "lighting", (f) => f.bright * (1 - f.warm)],
  ["golden hour", "lighting", (f) => f.warm * f.bright * 0.8],
  ["dim", "lighting", (f) => f.dark],
  ["backlit", "lighting", (f) => f.contrast * f.skyBlue],
  ["harsh light", "lighting", (f) => f.contrast * f.bright],
  ["calm", "mood", (f) => (1 - f.edge) * (1 - f.contrast)],
  ["busy", "mood", (f) => f.edge * f.detail],
  ["warm", "mood", (f) => f.warm],
  ["cool", "mood", (f) => f.cool],
  ["joyful", "mood", (f) => f.bright * f.warm * 0.6 + f.skyBlue * 0.3],
  ["quiet", "mood", (f) => f.dark * (1 - f.edge)],
];

function px(rgba, i) {
  return [rgba[i], rgba[i + 1], rgba[i + 2]];
}

export function measureFrame(rgba, width, height) {
  const stride = Math.max(1, Math.floor((width * height) / 2500));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let skyBlue = 0;
  let skyWhite = 0;
  let sand = 0;
  let green = 0;
  let skin = 0;
  let water = 0;
  let dark = 0;
  let bright = 0;
  let warm = 0;
  let cool = 0;
  let gray = 0;
  const horizon = Math.floor(height * 0.45);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      if ((idx / 4) % stride !== 0) continue;
      const [pr, pg, pb] = px(rgba, idx);
      const yv = (pr * 0.2126 + pg * 0.7152 + pb * 0.0722) / 255;
      r += pr;
      g += pg;
      b += pb;
      n++;
      if (yv < 0.18) dark++;
      if (yv > 0.72) bright++;
      if (pr > pb + 18 && pr > pg) warm++;
      if (pb > pr + 12) cool++;
      if (Math.abs(pr - pg) < 14 && Math.abs(pg - pb) < 14) gray++;
      if (y < horizon && pb > pr + 15 && pb > 80 && pg > 60) skyBlue++;
      if (y < horizon && pr > 180 && pg > 180 && pb > 180) skyWhite++;
      if (y >= horizon && pr > 150 && pg > 120 && pb < 110 && pr > pb) sand++;
      if (pg > pr + 10 && pg > pb) green++;
      if (pr > 140 && pg > 90 && pb > 60 && pr > pb && pr - pg < 80 && y > height * 0.2) skin++;
      if (pb > 70 && pb > pr && pg > 50 && y > height * 0.35) water++;
    }
  }
  const inv = n || 1;
  let edge = 0;
  let samples = 0;
  const step = Math.max(1, Math.floor(width / 48));
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const a = px(rgba, (y * width + x) * 4);
      const c = px(rgba, (y * width + x + step) * 4);
      edge += Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]);
      samples++;
    }
  }
  const edgeN = samples ? edge / samples / (255 * 3) : 0;
  return {
    skyBlue: skyBlue / inv,
    skyWhite: skyWhite / inv,
    sand: sand / inv,
    green: green / inv,
    skin: skin / inv,
    water: water / inv,
    dark: dark / inv,
    bright: bright / inv,
    warm: warm / inv,
    cool: cool / inv,
    grayGround: gray / inv,
    indoor: clamp01(0.55 * (1 - skyBlue / inv) * (1 - (bright / inv)) + (gray / inv) * 0.3),
    edge: clamp01(edgeN * 2.2),
    detail: clamp01(edgeN * 3),
    contrast: clamp01(Math.abs(bright - dark) / inv * inv + edgeN),
    lowSun: clamp01((warm / inv) * 2),
    warmSky: clamp01((warm / inv) * (skyWhite / inv + 0.2)),
    mean: [r / inv / 255, g / inv / 255, b / inv / 255],
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function embeddingFromFrames(frames) {
  const acc = new Array(24).fill(0);
  frames.forEach((frame) => {
    const m = measureFrame(frame.rgba, frame.width, frame.height);
    const values = [
      m.skyBlue, m.skyWhite, m.sand, m.green, m.skin, m.water, m.dark, m.bright,
      m.warm, m.cool, m.grayGround, m.indoor, m.edge, m.detail, m.contrast, m.lowSun,
      m.mean[0], m.mean[1], m.mean[2], m.warmSky, 1 - m.indoor, m.edge * m.detail,
      m.bright * m.warm, m.dark * m.cool,
    ];
    values.forEach((value, i) => {
      acc[i] += value;
    });
  });
  const scale = frames.length || 1;
  return acc.map((value) => value / scale);
}

export function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}

export function tagsFromFrames(frames, limit = 12) {
  if (!frames?.length) return [];
  const measures = frames.map((frame) => measureFrame(frame.rgba, frame.width, frame.height));
  const scored = VOCAB.map(([label, layer, score]) => {
    const value = measures.reduce((sum, frame) => sum + score(frame), 0) / measures.length;
    return { label, layer, score: value };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const tag of scored) {
    if (picked.length >= limit) break;
    if (tag.score < 0.04 && picked.length >= 10) break;
    picked.push({ label: tag.label, layer: tag.layer, score: Math.round(tag.score * 1000) / 1000 });
  }
  for (const tag of scored) {
    if (picked.length >= 10) break;
    if (!picked.some((item) => item.label === tag.label)) {
      picked.push({ label: tag.label, layer: tag.layer, score: Math.round(tag.score * 1000) / 1000 });
    }
  }
  return picked;
}

export function editTags(tags, { add, remove } = {}) {
  const next = (tags || []).map((tag) => ({ ...tag }));
  if (remove) {
    return next.filter((tag) => tag.label !== remove);
  }
  if (add?.label) {
    if (!next.some((tag) => tag.label === add.label)) {
      next.push({ label: String(add.label).slice(0, 40), layer: add.layer || "custom", score: 1 });
    }
  }
  return next;
}

export function groupSimilar(items, threshold = 0.82) {
  const groups = [];
  const used = new Set();
  items.forEach((item, index) => {
    if (used.has(index) || !item.embedding) return;
    const group = [item];
    used.add(index);
    items.forEach((other, otherIndex) => {
      if (used.has(otherIndex) || !other.embedding) return;
      if (cosine(item.embedding, other.embedding) >= threshold) {
        group.push(other);
        used.add(otherIndex);
      }
    });
    if (group.length > 1) groups.push(group);
  });
  return groups;
}

export function matchesTags(item, query) {
  const wanted = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!wanted.length) return true;
  const labels = (item.tags || []).map((tag) => tag.label.toLowerCase());
  return wanted.every((word) => labels.some((label) => label.includes(word)));
}
