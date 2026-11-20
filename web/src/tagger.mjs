/** Lazy MobileCLIP + YAMNet sessions. Frames stay on this phone. */
import { estimateShift, grayscale } from "./process.mjs";
import { cosine, describeEmbeddings } from "./tags.mjs";

const IMAGE = 256;
let promptsPromise = null;
let visionPromise = null;
let yamnetPromise = null;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The tagging model files are missing from this copy of the app.");
  return response.json();
}

export function loadPrompts() {
  if (!promptsPromise) promptsPromise = fetchJson(new URL("models/mobileclip-tags.json", document.baseURI).href);
  return promptsPromise;
}

async function session(url) {
  const ort = globalThis.ort;
  if (!ort) throw new Error("The on-device model engine did not load.");
  ort.env.wasm.wasmPaths = new URL("ort/", document.baseURI).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const providers = [];
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) providers.push("webgpu");
    } catch {
      /* wasm below */
    }
  }
  providers.push("wasm");
  return ort.InferenceSession.create(url, { executionProviders: providers, graphOptimizationLevel: "all" });
}

function loadVision() {
  if (!visionPromise) visionPromise = session(new URL("models/mobileclip-s0-vision.onnx", document.baseURI).href);
  return visionPromise;
}

function loadYamnet() {
  if (!yamnetPromise) yamnetPromise = session(new URL("models/yamnet.onnx", document.baseURI).href);
  return yamnetPromise;
}

function imageTensor(rgba, width, height) {
  const scale = IMAGE / Math.min(width, height);
  const resizedW = Math.max(IMAGE, Math.round(width * scale));
  const resizedH = Math.max(IMAGE, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = resizedW;
  canvas.height = resizedH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const image = new ImageData(new Uint8ClampedArray(rgba), width, height);
  source.getContext("2d").putImageData(image, 0, 0);
  ctx.drawImage(source, 0, 0, resizedW, resizedH);
  const left = Math.floor((resizedW - IMAGE) / 2);
  const top = Math.floor((resizedH - IMAGE) / 2);
  const crop = ctx.getImageData(left, top, IMAGE, IMAGE).data;
  const data = new Float32Array(3 * IMAGE * IMAGE);
  for (let i = 0; i < IMAGE * IMAGE; i++) {
    data[i] = crop[i * 4] / 255;
    data[IMAGE * IMAGE + i] = crop[i * 4 + 1] / 255;
    data[2 * IMAGE * IMAGE + i] = crop[i * 4 + 2] / 255;
  }
  return new globalThis.ort.Tensor("float32", data, [1, 3, IMAGE, IMAGE]);
}

async function embedFrame(vision, rgba, width, height) {
  const tensor = imageTensor(rgba, width, height);
  const output = await vision.run({ pixel_values: tensor });
  const values = output.image_embeds?.data || Object.values(output)[0].data;
  let norm = 0;
  for (let i = 0; i < values.length; i++) norm += values[i] * values[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(values, (value) => value / norm);
}

function centerCropEmbeddingInput(rgba, width, height) {
  const side = Math.floor(Math.min(width, height) * 0.45);
  const x = Math.floor((width - side) / 2);
  const y = Math.floor(height * 0.12);
  const crop = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row++) {
    const src = ((y + row) * width + x) * 4;
    crop.set(rgba.subarray(src, src + side * 4), row * side * 4);
  }
  return { rgba: crop, width: side, height: side };
}

const AUDIO_GROUPS = {
  speech: [0, 1, 2, 3, 12],
  music: [132, 262, 241],
  television: [518],
  silence: [494],
  laughter: [13, 14],
  dog: [69, 117],
  water: [282, 364],
  traffic: [321],
  crowd: [64, 65],
  dishes: [358, 360],
  footsteps: [48],
};

function resample16k(samples, sampleRate) {
  if (!samples?.length) return new Float32Array();
  if (sampleRate === 16000) return samples;
  const length = Math.floor((samples.length * 16000) / sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = (i * sampleRate) / 16000;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[Math.min(i0, samples.length - 1)] || 0;
    const b = samples[Math.min(i0 + 1, samples.length - 1)] || 0;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

async function classifyAudio(samples, sampleRate) {
  const wave = resample16k(samples, sampleRate);
  if (wave.length < 8000) return null;
  const model = await loadYamnet();
  const clip = wave.subarray(0, Math.min(wave.length, 16000 * 12));
  const tensor = new globalThis.ort.Tensor("float32", clip, [clip.length]);
  const output = await model.run({ waveform: tensor });
  const scores = output.output_0?.data || Object.values(output)[0].data;
  const frames = Math.max(1, Math.floor(scores.length / 521));
  const totals = {};
  for (const [label, indexes] of Object.entries(AUDIO_GROUPS)) {
    let sum = 0;
    for (let frame = 0; frame < frames; frame++) {
      for (const index of indexes) sum += scores[frame * 521 + index] || 0;
    }
    totals[label] = sum / frames;
  }
  return totals;
}

function motionShifts(frames) {
  const shifts = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const next = frames[i];
    const width = Math.min(prev.width, next.width, 96);
    const height = Math.min(prev.height, next.height, 54);
    const a = grayscale(down(prev, width, height), width, height);
    const b = grayscale(down(next, width, height), width, height);
    const shift = estimateShift(a, b, width, height, 4);
    shifts.push({ dx: shift.dx, dy: shift.dy });
  }
  return shifts;
}

function down(frame, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const source = document.createElement("canvas");
  source.width = frame.width;
  source.height = frame.height;
  source.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

export async function describeFrames({ frames, audio = null, people = [] }) {
  if (!frames?.length) throw new Error("No frames to tag.");
  const [pack, vision] = await Promise.all([loadPrompts(), loadVision()]);
  const embeddings = [];
  for (const frame of frames) embeddings.push(await embedFrame(vision, frame.rgba, frame.width, frame.height));
  const mean = average(embeddings);
  let faceEmbeddings = [];
  const peopleGuess = bestPrompt(mean, pack.prompts, "people");
  const framing = bestPrompt(mean, pack.prompts, "camera");
  if (peopleGuess && (peopleGuess.label === "one" || peopleGuess.label === "two") && framing?.label === "close-up") {
    const face = centerCropEmbeddingInput(frames[0].rgba, frames[0].width, frames[0].height);
    if (face.width >= 32) faceEmbeddings = [await embedFrame(vision, face.rgba, face.width, face.height)];
  }
  let audioScores = null;
  if (audio?.samples?.length) {
    try {
      audioScores = await classifyAudio(audio.samples, audio.sampleRate || 48000);
    } catch {
      audioScores = null;
    }
  }
  return describeEmbeddings({
    meanEmbedding: mean,
    frameEmbeddings: embeddings,
    prompts: pack.prompts,
    shifts: motionShifts(frames),
    audioScores,
    people,
    faceEmbeddings,
  });
}

function bestPrompt(embedding, prompts, facet) {
  let top = null;
  for (const prompt of prompts) {
    if (prompt.facet !== facet) continue;
    const score = cosine(embedding, prompt.vector);
    if (!top || score > top.score) top = { label: prompt.label, score };
  }
  return top;
}

function average(vectors) {
  const length = vectors[0].length;
  const acc = new Array(length).fill(0);
  for (const vector of vectors) for (let i = 0; i < length; i++) acc[i] += vector[i];
  let norm = 0;
  for (let i = 0; i < length; i++) {
    acc[i] /= vectors.length;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm) || 1;
  return acc.map((value) => value / norm);
}
