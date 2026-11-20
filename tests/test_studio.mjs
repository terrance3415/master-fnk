import assert from "node:assert/strict";
import test from "node:test";

import { detectBeats, micCleanup, mixFilmAudio, stereoWiden } from "../web/src/audio.mjs";
import { detectChapters } from "../web/src/chapters.mjs";
import { applyCinematic, applyCorrection, suggestCorrection } from "../web/src/color.mjs";
import { ASPECTS, buildTimeline, insertClipAt, outputSize, sourceRanges } from "../web/src/filmmath.mjs";
import { FLIGHT_MS, LAND_AT_MS, flightSrc } from "../web/src/flight.mjs";
import { interpolateRgba } from "../web/src/interp.mjs";
import { cuesFromScript, parseSrt, toSrt } from "../web/src/subs.mjs";
import { FACET_WEIGHTS, GROUP_THRESHOLD, cosine, describeEmbeddings, facetSimilarity, groupSimilar } from "../web/src/tags.mjs";

test("trim, middle cut, and insert keep the pieces in order", () => {
  const host = { id: "a", kind: "video", duration: 10, width: 1280, height: 720, trimIn: 1, trimOut: 9, cutIn: 4, cutOut: 5 };
  const ranges = sourceRanges(host);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].end <= 4.01);
  assert.ok(ranges[1].start >= 4.99);
  const guest = { id: "b", kind: "video", duration: 2, width: 640, height: 360 };
  const clips = insertClipAt([host, guest], 0, 1, 3);
  assert.deepEqual(clips.map((clip) => clip.id), ["a-a", "b", "a-b"]);
  const timeline = buildTimeline(clips, { resolution: "720", slowMo: 1 });
  assert.equal(timeline.error, undefined);
  assert.ok(timeline.segments.length >= 3);
  assert.ok(timeline.transition > 0);
});

test("export shapes stay at least 720 on the short side", () => {
  for (const aspect of Object.keys(ASPECTS)) {
    for (const resolution of ["720", "1080", "2160"]) {
      const size = outputSize(resolution, aspect);
      assert.ok(Math.min(size.width, size.height) >= 720);
    }
  }
  const vertical = outputSize("720", "9:16");
  assert.equal(vertical.width, 720);
  assert.equal(vertical.height, 1280);
});

test("color correction and the cinematic grade change pixels and can stack", () => {
  const rgba = new Uint8ClampedArray([20, 40, 180, 255, 240, 200, 80, 255]);
  const brighter = applyCorrection(rgba, { exposure: 1 });
  assert.ok(brighter[0] > rgba[0]);
  const graded = applyCinematic(rgba, 0.8);
  assert.ok(graded[2] > graded[0]);
  const stacked = applyCorrection(applyCinematic(rgba, 0.8), { exposure: 0.5 });
  assert.notDeepEqual([...stacked], [...rgba]);
  const washed = new Uint8ClampedArray(64 * 36 * 4);
  for (let i = 0; i < washed.length; i += 4) {
    washed[i] = 210;
    washed[i + 1] = 160;
    washed[i + 2] = 90;
    washed[i + 3] = 255;
  }
  const suggestion = suggestCorrection(washed);
  assert.ok(suggestion.temperature < 0);
});

test("mute, duck, mic cleanup, and stereo width", () => {
  const rate = 8000;
  const tone = new Float32Array(rate);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 60 * i) / rate) * 0.5;
  const cleaned = micCleanup(tone, rate, 1);
  let raw = 0;
  let after = 0;
  for (let i = 0; i < tone.length; i++) {
    raw += tone[i] * tone[i];
    after += cleaned[i] * cleaned[i];
  }
  assert.ok(after < raw);
  const music = new Float32Array(rate);
  for (let i = 0; i < music.length; i++) music[i] = 0.4;
  const ducked = mixFilmAudio({
    duration: 1,
    sampleRate: rate,
    segments: [{ kind: "video", index: 0, clipIndex: 0, start: 0, end: 1, sourceStart: 0, sourceUsed: 1 }],
    clipAudio: [{ sampleRate: rate, channels: [tone, tone] }],
    music: { sampleRate: rate, channels: [music, music] },
    audioMode: "duck",
    transition: 0,
  });
  const kept = mixFilmAudio({
    duration: 1,
    sampleRate: rate,
    segments: [{ kind: "video", index: 0, clipIndex: 0, start: 0, end: 1, sourceStart: 0, sourceUsed: 1 }],
    clipAudio: [{ sampleRate: rate, channels: [tone, tone] }],
    music: { sampleRate: rate, channels: [music, music] },
    audioMode: "keep",
    transition: 0,
  });
  let duckEnergy = 0;
  let keepEnergy = 0;
  for (let i = 0; i < ducked.left.length; i++) {
    duckEnergy += Math.abs(ducked.left[i]);
    keepEnergy += Math.abs(kept.left[i]);
  }
  assert.ok(duckEnergy < keepEnergy);
  const wide = stereoWiden(tone, tone, 0.8, rate);
  let sum = 0;
  let diff = 0;
  for (let i = 0; i < wide.left.length; i++) {
    sum += Math.abs(wide.left[i] + wide.right[i] - tone[i] * 2);
    diff += Math.abs(wide.left[i] - wide.right[i]);
  }
  assert.ok(sum < 1);
  assert.ok(diff > 1);
  const beats = detectBeats(Float32Array.from({ length: rate }, (_, i) => (i % 4000 < 40 ? 1 : 0)), rate, 200);
  assert.ok(beats.length >= 1);
});

test("interpolation moves a block instead of only holding a frame", () => {
  const width = 32;
  const height = 16;
  const paint = (x0) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 4; y < 12; y++) {
      for (let x = x0; x < x0 + 6; x++) {
        const p = (y * width + x) * 4;
        rgba[p] = 255;
        rgba[p + 1] = 255;
        rgba[p + 2] = 255;
        rgba[p + 3] = 255;
      }
    }
    return rgba;
  };
  const mid = interpolateRgba(paint(2), paint(20), width, height, 0.5, { block: 8, radius: 6, cutThreshold: 1 });
  let mass = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = mid[(y * width + x) * 4];
      mass += x * value;
      weight += value;
    }
  }
  const center = mass / weight;
  assert.ok(center > 6 && center < 22);
});

test("facet grouping needs more than the same room", () => {
  const weight = Object.values(FACET_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(weight - 1) < 1e-6);
  assert.ok(Math.max(...Object.values(FACET_WEIGHTS)) < GROUP_THRESHOLD);
  const shared = {
    embedding: [1, 0],
    facets: {
      room: "kitchen",
      furniture: ["stove", "refrigerator"],
      objects: ["cup"],
      clothing: ["blue shirt"],
      actions: ["cooking at a stove"],
      sequence: ["walking through a room", "cooking at a stove", "eating a meal"],
      peopleIds: ["p1"],
      audio: ["dishes"],
      camera: ["wide shot", "handheld"],
      time: "evening",
      lighting: ["overhead light"],
      mood: ["lively"],
      posed: "candid",
    },
  };
  const twin = structuredClone(shared);
  const roomOnly = {
    embedding: [0, 1],
    facets: { room: "kitchen", furniture: [], objects: [], clothing: [], actions: [], sequence: [], peopleIds: [], audio: [], camera: [], lighting: [], mood: [] },
  };
  assert.ok(facetSimilarity(shared, twin).score >= GROUP_THRESHOLD);
  assert.ok(facetSimilarity(shared, roomOnly).score < GROUP_THRESHOLD);
  const groups = groupSimilar([shared, twin, roomOnly]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("low-confidence tags are flagged and a close call is dropped", () => {
  const axis = (x) => [x, Math.sqrt(1 - x * x)];
  const prompts = [
    { facet: "room", label: "kitchen", layer: "setting", mode: "exclusive", minScore: 0.2, minMargin: 0.05, vector: axis(1) },
    { facet: "room", label: "bedroom", layer: "setting", mode: "exclusive", minScore: 0.2, minMargin: 0.05, vector: axis(0.99) },
    { facet: "object", label: "cup", layer: "subject", mode: "multi", minScore: 0.2, minMargin: 0.02, vector: axis(0.9) },
    { facet: "baseline", label: "baseline", mode: "baseline", vector: axis(0.2) },
  ];
  const described = describeEmbeddings({
    meanEmbedding: axis(1),
    frameEmbeddings: [axis(1)],
    prompts,
  });
  assert.equal(described.facets.room, null);
  assert.ok(described.tags.some((tag) => tag.label === "cup"));
});

test("a mode figure flies, then stays on the landed cutout", () => {
  const theme = { fly: "flying.png", fig: "landed.png" };
  assert.equal(flightSrc(theme, false, 0), "flying.png");
  assert.equal(flightSrc(theme, false, LAND_AT_MS - 1), "flying.png");
  assert.equal(flightSrc(theme, false, LAND_AT_MS), "landed.png");
  assert.equal(flightSrc(theme, true, 0), "landed.png");
  assert.ok(FLIGHT_MS >= 600 && FLIGHT_MS <= 900);
  assert.ok(LAND_AT_MS < FLIGHT_MS);
});

test("chapters follow a hard cut and captions round-trip", () => {
  const chapters = detectChapters([0.01, 0.02, 0.5, 0.01], [0, 1, 2, 3, 4], 0.18);
  assert.ok(chapters.some((chapter) => chapter.time >= 2.9 || chapter.time >= 2));
  const cues = cuesFromScript("one two three four", 4);
  assert.equal(cues[0].words.length >= 1, true);
  const parsed = parseSrt(toSrt(cues));
  assert.equal(parsed[0].text.split(" ")[0], "one");
  assert.ok(parsed[0].words.length >= 1);
});
