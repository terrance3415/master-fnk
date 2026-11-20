/**
 * Facet scoring and grouping for on-device tags.
 * The vision model lives in tagger.mjs. This file only does the math.
 */

export const TAGGER_ID = "mobileclip-s0-fp32+yamnet-v1";
export const GROUP_THRESHOLD = 0.62;

/** Weights sum to 1. No single facet can reach GROUP_THRESHOLD on its own. */
export const FACET_WEIGHTS = Object.freeze({
  scene: 0.14,
  room: 0.08,
  furniture: 0.08,
  objects: 0.1,
  clothing: 0.1,
  actions: 0.1,
  sequence: 0.08,
  people: 0.1,
  audio: 0.06,
  camera: 0.04,
  time: 0.04,
  lighting: 0.04,
  mood: 0.02,
  posed: 0.02,
});

export function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}

export function jaccard(a, b) {
  const left = new Set(a || []);
  const right = new Set(b || []);
  if (!left.size && !right.size) return 1;
  let hit = 0;
  for (const item of left) if (right.has(item)) hit += 1;
  const union = left.size + right.size - hit;
  return union ? hit / union : 0;
}

export function sequenceSimilarity(a, b) {
  const left = a || [];
  const right = b || [];
  if (left.length < 2 || right.length < 2) return 0;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = new Uint16Array(rows * cols);
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = left[i - 1] === right[j - 1];
      dp[i * cols + j] = same
        ? dp[(i - 1) * cols + (j - 1)] + 1
        : Math.max(dp[(i - 1) * cols + j], dp[i * cols + (j - 1)]);
    }
  }
  return dp[rows * cols - 1] / Math.max(left.length, right.length);
}

function byFacet(prompts) {
  const groups = new Map();
  for (const prompt of prompts || []) {
    if (!groups.has(prompt.facet)) groups.set(prompt.facet, []);
    groups.get(prompt.facet).push(prompt);
  }
  return groups;
}

function scoreList(embedding, prompts) {
  return prompts.map((prompt) => ({ ...prompt, score: cosine(embedding, prompt.vector) }));
}

export function pickExclusive(scored, { forceLow = false } = {}) {
  if (!scored?.length) return null;
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const margin = best.score - (second?.score || 0);
  const minScore = best.minScore ?? 0.18;
  const minMargin = best.minMargin ?? 0.015;
  if (best.score < minScore || margin < minMargin * 0.5) return null;
  const confidence = !forceLow && best.score >= minScore && margin >= minMargin ? "high" : "low";
  if (confidence === "low" && margin < minMargin * 0.5) return null;
  return { label: best.label, layer: best.layer, facet: best.facet, score: round3(best.score), margin: round3(margin), confidence };
}

export function pickMulti(scored, baseline = 0) {
  const kept = [];
  for (const item of [...(scored || [])].sort((a, b) => b.score - a.score)) {
    const minScore = item.minScore ?? 0.2;
    const minMargin = item.minMargin ?? 0.015;
    if (item.score < minScore) continue;
    const margin = item.score - baseline;
    if (margin < minMargin * 0.5) continue;
    const confidence = margin >= minMargin && item.score >= minScore + 0.02 ? "high" : "low";
    kept.push({
      label: item.label,
      layer: item.layer,
      facet: item.facet,
      score: round3(item.score),
      margin: round3(margin),
      confidence,
    });
    if (kept.length >= 6) break;
  }
  return kept;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function highLabels(picks) {
  return (picks || []).filter((item) => item && item.confidence === "high").map((item) => item.label);
}

export function cameraFromMotion(shifts = []) {
  if (!shifts.length) return { labels: [], confidence: "low" };
  let mean = 0;
  let pan = 0;
  let signChanges = 0;
  let lastSign = 0;
  for (const shift of shifts) {
    const mag = Math.hypot(shift.dx || 0, shift.dy || 0);
    mean += mag;
    pan += shift.dx || 0;
    const sign = Math.sign(shift.dx || 0);
    if (sign && lastSign && sign !== lastSign) signChanges += 1;
    if (sign) lastSign = sign;
  }
  mean /= shifts.length;
  const labels = [];
  if (mean < 0.35) labels.push("static");
  else if (Math.abs(pan) > shifts.length * 0.8 && signChanges <= 1) labels.push("panning");
  else labels.push("handheld");
  return { labels, confidence: shifts.length >= 2 ? "high" : "low" };
}

export function audioTagsFromScores(scores = {}) {
  const ranked = Object.entries(scores)
    .filter(([, value]) => value >= 0.2)
    .sort((a, b) => b[1] - a[1]);
  if (scores.silence >= 0.85) return [{ label: "silence", layer: "audio", facet: "audio", score: round3(scores.silence), confidence: "high" }];
  return ranked.slice(0, 4).map(([label, score]) => ({
    label,
    layer: "audio",
    facet: "audio",
    score: round3(score),
    confidence: score >= 0.35 ? "high" : "low",
  }));
}

export function personName(index) {
  if (index < 26) return `Person ${String.fromCharCode(65 + index)}`;
  return `Person ${index + 1}`;
}

/** Match anonymous appearance embeddings. High threshold to avoid merging different people. */
export function matchPeople(faceEmbeddings, catalog, threshold = 0.72) {
  const people = Array.isArray(catalog) ? catalog : [];
  const ids = [];
  for (const embedding of faceEmbeddings || []) {
    let best = null;
    let bestScore = threshold;
    for (const person of people) {
      const score = cosine(embedding, person.embedding);
      if (score >= bestScore) {
        best = person;
        bestScore = score;
      }
    }
    if (!best) {
      best = {
        id: `p${people.length + 1}`,
        name: personName(people.length),
        embedding: Array.from(embedding).map((value) => round3(value)),
      };
      people.push(best);
    }
    if (!ids.includes(best.id)) ids.push(best.id);
  }
  return { ids, people };
}

function topAction(embedding, prompts) {
  const actions = (prompts || []).filter((prompt) => prompt.facet === "action");
  let best = null;
  for (const prompt of actions) {
    const score = cosine(embedding, prompt.vector);
    if (!best || score > best.score) best = { label: prompt.label, score, minScore: prompt.minScore ?? 0.2 };
  }
  if (!best || best.score < best.minScore) return null;
  return best.label;
}

export function describeEmbeddings({
  meanEmbedding,
  frameEmbeddings = [],
  prompts = [],
  shifts = [],
  audioScores = null,
  people = [],
  faceEmbeddings = [],
} = {}) {
  const groups = byFacet(prompts);
  const scoredMean = new Map();
  for (const [facet, list] of groups) scoredMean.set(facet, scoreList(meanEmbedding, list));
  const baseline = (scoredMean.get("baseline") || [])[0]?.score || 0;
  const room = pickExclusive(scoredMean.get("room"));
  const peopleCount = pickExclusive(scoredMean.get("people"));
  const time = pickExclusive(scoredMean.get("time"));
  const framing = pickExclusive(scoredMean.get("camera"));
  const posed = pickExclusive(scoredMean.get("posed"), { forceLow: true });
  const furniture = pickMulti(scoredMean.get("furniture"), baseline);
  const clothing = pickMulti(scoredMean.get("clothing"), baseline);
  const actions = pickMulti(scoredMean.get("action"), baseline);
  const objects = pickMulti(scoredMean.get("object"), baseline);
  const lighting = pickMulti(scoredMean.get("lighting"), baseline);
  const mood = pickMulti(scoredMean.get("mood"), baseline);
  const sequence = [];
  for (const embedding of frameEmbeddings) {
    const label = topAction(embedding, prompts);
    if (label && sequence[sequence.length - 1] !== label) sequence.push(label);
  }
  const motion = cameraFromMotion(shifts);
  const audio = audioScores ? audioTagsFromScores(audioScores) : [];
  const matched = matchPeople(faceEmbeddings, people);
  const tags = [];
  const push = (item) => {
    if (!item) return;
    if (!tags.some((tag) => tag.label === item.label)) tags.push(item);
  };
  push(room);
  const countLabels = { none: "no people", one: "one person", two: "two people", few: "a few people", crowd: "a crowd" };
  push(peopleCount ? { ...peopleCount, label: countLabels[peopleCount.label] || peopleCount.label } : null);
  for (const id of matched.ids) {
    const person = matched.people.find((item) => item.id === id);
    push({ label: person?.name || id, layer: "subject", facet: "people", score: 1, confidence: "low" });
  }
  for (const list of [furniture, clothing, actions, objects, lighting, mood, audio]) list.forEach(push);
  push(time);
  if (framing) push({ ...framing, layer: "scene" });
  for (const label of motion.labels) {
    push({ label, layer: "scene", facet: "camera", score: 1, confidence: motion.confidence });
  }
  push(posed ? { ...posed, label: posed.label === "posed" ? "posed" : "candid" } : null);
  const facets = {
    room: room?.confidence === "high" ? room.label : null,
    furniture: highLabels(furniture),
    objects: highLabels(objects),
    clothing: highLabels(clothing),
    actions: highLabels(actions),
    sequence: sequence.slice(0, 8),
    peopleCount: peopleCount?.confidence === "high" ? peopleCount.label : null,
    peopleIds: matched.ids,
    audio: highLabels(audio),
    camera: [...(framing?.confidence === "high" ? [framing.label] : []), ...(motion.confidence === "high" ? motion.labels : [])],
    time: time?.confidence === "high" ? time.label : null,
    lighting: highLabels(lighting),
    mood: highLabels(mood),
    posed: posed?.label || null,
  };
  return {
    tagger: TAGGER_ID,
    tags,
    embedding: Array.from(meanEmbedding || []).map(round3),
    facets,
    people: matched.people,
  };
}

function setScore(a, b) {
  if (!a?.length || !b?.length) return 0;
  return jaccard(a, b);
}

function oneScore(a, b) {
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}

export function facetSimilarity(left, right) {
  const a = left?.facets || {};
  const b = right?.facets || {};
  const scene = Math.max(0, cosine(left?.embedding, right?.embedding));
  const parts = {
    scene,
    room: oneScore(a.room, b.room),
    furniture: setScore(a.furniture, b.furniture),
    objects: setScore(a.objects, b.objects),
    clothing: setScore(a.clothing, b.clothing),
    actions: setScore(a.actions, b.actions),
    sequence: sequenceSimilarity(a.sequence, b.sequence),
    people: setScore(a.peopleIds, b.peopleIds),
    audio: setScore(a.audio, b.audio),
    camera: setScore(a.camera, b.camera),
    time: oneScore(a.time, b.time),
    lighting: setScore(a.lighting, b.lighting),
    mood: setScore(a.mood, b.mood),
    posed: a.posed && b.posed && a.posed === b.posed ? 1 : 0,
  };
  let total = 0;
  for (const [key, weight] of Object.entries(FACET_WEIGHTS)) total += weight * (parts[key] || 0);
  return { score: total, parts };
}

export function groupSimilar(items, threshold = GROUP_THRESHOLD) {
  const groups = [];
  const used = new Set();
  items.forEach((item, index) => {
    if (used.has(index) || !item?.facets || !item?.embedding) return;
    const group = [item];
    used.add(index);
    items.forEach((other, otherIndex) => {
      if (used.has(otherIndex) || !other?.facets || !other?.embedding) return;
      if (facetSimilarity(item, other).score >= threshold) {
        group.push(other);
        used.add(otherIndex);
      }
    });
    if (group.length > 1) groups.push(group);
  });
  return groups;
}

export function editTags(tags, { add, remove } = {}) {
  const next = (tags || []).map((tag) => ({ ...tag }));
  if (remove) return next.filter((tag) => tag.label !== remove);
  if (add?.label && !next.some((tag) => tag.label === add.label)) {
    next.push({ label: String(add.label).slice(0, 48), layer: add.layer || "custom", confidence: "high", score: 1 });
  }
  return next;
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

export function meanEmbedding(vectors) {
  if (!vectors?.length) return [];
  const length = vectors[0].length;
  const acc = new Array(length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < length; i++) acc[i] += vector[i];
  }
  const scale = vectors.length;
  let norm = 0;
  for (let i = 0; i < length; i++) {
    acc[i] /= scale;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm) || 1;
  return acc.map((value) => value / norm);
}
