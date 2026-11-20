/** Phone-side audio: original track, TV ducking, mic cleanup, stereo width, beats. */

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function dbiquad(kind, freq, sampleRate, q = 0.707) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;
  if (kind === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (kind === "notch") {
    b0 = 1;
    b1 = -2 * cos;
    b2 = 1;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (kind === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filterInPlace(samples, coeff, mix) {
  const wet = clamp(mix, 0, 1);
  if (wet === 0) return samples;
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = coeff.b0 * x + coeff.b1 * x1 + coeff.b2 * x2 - coeff.a1 * y1 - coeff.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = x * (1 - wet) + y * wet;
  }
  return out;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Wind high-pass, mains hum notches, and a hiss expander. Independent of TV soften. */
export function micCleanup(samples, sampleRate, amount) {
  const wet = clamp(Number(amount) || 0, 0, 1);
  if (wet === 0) return samples.slice();
  let out = filterInPlace(samples, dbiquad("highpass", 90, sampleRate, 0.7), wet);
  for (const freq of [50, 60, 100, 120]) {
    if (freq < sampleRate / 2) out = filterInPlace(out, dbiquad("notch", freq, sampleRate, 12), wet * 0.9);
  }
  const noise = rms(out) * 0.35;
  for (let i = 0; i < out.length; i++) {
    const mag = Math.abs(out[i]);
    if (mag < noise) out[i] *= 1 - wet * 0.85;
  }
  return out;
}

/** Reduce a broadcast-like bed: small-speaker band emphasis pulled down, plus an expander. */
export function broadcastSoften(samples, sampleRate, amount) {
  const wet = clamp(Number(amount) || 0, 0, 1);
  if (wet === 0) return samples.slice();
  let out = filterInPlace(samples, dbiquad("highpass", 180, sampleRate, 0.7), wet);
  out = filterInPlace(out, dbiquad("lowpass", 4500, sampleRate, 0.7), wet * 0.55);
  out = filterInPlace(out, dbiquad("notch", 2000, sampleRate, 1.2), wet * 0.7);
  const floor = rms(out) * 0.5;
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i]) < floor) out[i] *= 1 - wet * 0.9;
  }
  return out;
}

/** Mid/side widen. Mono input stays identical when summed back to mono. */
export function stereoWiden(left, right, amount, sampleRate = 48000) {
  const wet = clamp(Number(amount) || 0, 0, 1);
  const n = Math.min(left.length, right.length);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const delay = Math.max(1, Math.round(sampleRate * 0.012));
  for (let i = 0; i < n; i++) {
    const mid = (left[i] + right[i]) * 0.5;
    const delayed = i >= delay ? mid - (left[i - delay] + right[i - delay]) * 0.5 : 0;
    const side = delayed * wet * 0.85;
    outL[i] = mid + side;
    outR[i] = mid - side;
  }
  return { left: outL, right: outR };
}

function envelope(samples, window) {
  const out = new Float32Array(samples.length);
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    acc += samples[i] * samples[i];
    if (i >= window) {
      const old = samples[i - window];
      acc -= old * old;
    }
    out[i] = Math.sqrt(Math.max(0, acc) / window);
  }
  return out;
}

function stretch(samples, fromRate, sourceStart, sourceUsed, toRate, outDuration) {
  const outLen = Math.max(1, Math.round(outDuration * toRate));
  const out = new Float32Array(outLen);
  const start = sourceStart * fromRate;
  const span = Math.max(1, sourceUsed * fromRate);
  for (let i = 0; i < outLen; i++) {
    const pos = start + (i / Math.max(1, outLen)) * span;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[clamp(i0, 0, samples.length - 1)] || 0;
    const b = samples[clamp(i0 + 1, 0, samples.length - 1)] || 0;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

function addInto(dest, src, offset, fadeIn, fadeOut) {
  for (let i = 0; i < src.length; i++) {
    const at = offset + i;
    if (at < 0 || at >= dest.length) continue;
    let gain = 1;
    if (fadeIn > 0 && i < fadeIn) gain *= i / fadeIn;
    if (fadeOut > 0 && i > src.length - fadeOut) gain *= (src.length - i) / fadeOut;
    dest[at] += src[i] * gain;
  }
}

export function mixFilmAudio({
  duration,
  sampleRate = 48000,
  segments = [],
  clipAudio = [],
  music = null,
  audioMode = "keep",
  cleanup = 0,
  soften = 0,
  widen = 0,
  transition = 0.45,
}) {
  const n = Math.max(1, Math.ceil(duration * sampleRate));
  const origL = new Float32Array(n);
  const origR = new Float32Array(n);
  const fade = Math.round(transition * sampleRate);
  if (audioMode !== "mute") {
    segments.forEach((seg, index) => {
      if (seg.kind && seg.kind !== "video") return;
      const clip = clipAudio[seg.clipIndex ?? seg.index];
      if (!clip?.channels?.[0]) return;
      const outDur = Math.max(0.01, seg.end - seg.start);
      const sourceUsed = seg.sourceUsed || outDur;
      const stretchedL = stretch(clip.channels[0], clip.sampleRate, seg.sourceStart || 0, sourceUsed, sampleRate, outDur);
      const rightSrc = clip.channels[1] || clip.channels[0];
      const stretchedR = stretch(rightSrc, clip.sampleRate, seg.sourceStart || 0, sourceUsed, sampleRate, outDur);
      const offset = Math.round(seg.start * sampleRate);
      const fadeIn = index === 0 ? 0 : fade;
      const fadeOut = index === segments.length - 1 ? 0 : fade;
      addInto(origL, stretchedL, offset, fadeIn, fadeOut);
      addInto(origR, stretchedR, offset, fadeIn, fadeOut);
    });
  }
  let busL = micCleanup(origL, sampleRate, cleanup);
  let busR = micCleanup(origR, sampleRate, cleanup);
  const softenAmount = audioMode === "soften" ? Math.max(soften || 0.85, 0.4) : soften || 0;
  busL = broadcastSoften(busL, sampleRate, softenAmount);
  busR = broadcastSoften(busR, sampleRate, softenAmount);

  const musicL = new Float32Array(n);
  const musicR = new Float32Array(n);
  if (music?.channels?.[0]) {
    const musicDur = music.channels[0].length / music.sampleRate;
    const playFor = Math.min(musicDur, duration);
    const placedL = stretch(music.channels[0], music.sampleRate, 0, playFor, sampleRate, playFor);
    const placedR = stretch(music.channels[1] || music.channels[0], music.sampleRate, 0, playFor, sampleRate, playFor);
    musicL.set(placedL.subarray(0, n));
    musicR.set(placedR.subarray(0, n));
  }
  if (audioMode === "duck" && music) {
    const env = envelope(musicL, Math.max(1, Math.round(sampleRate * 0.05)));
    let peak = 0.0001;
    for (let i = 0; i < env.length; i++) peak = Math.max(peak, env[i]);
    for (let i = 0; i < n; i++) {
      const duck = 1 - 0.78 * Math.min(1, env[i] / peak);
      busL[i] *= duck;
      busR[i] *= duck;
    }
  }
  const wideOrig = stereoWiden(busL, busR, widen, sampleRate);
  const wideMusic = stereoWiden(musicL, musicR, widen, sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let peak = 0.0001;
  for (let i = 0; i < n; i++) {
    left[i] = wideOrig.left[i] + wideMusic.left[i];
    right[i] = wideOrig.right[i] + wideMusic.right[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > 0.98) {
    const gain = 0.98 / peak;
    for (let i = 0; i < n; i++) {
      left[i] *= gain;
      right[i] *= gain;
    }
  }
  return { left, right, sampleRate };
}

export function detectBeats(samples, sampleRate, hop = 512) {
  const energies = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) sum += samples[i + j] * samples[i + j];
    energies.push(sum / hop);
  }
  const beats = [];
  for (let i = 2; i < energies.length - 2; i++) {
    const prev = (energies[i - 1] + energies[i - 2]) * 0.5;
    if (energies[i] > prev * 1.6 && energies[i] > 0.0004 && energies[i] >= energies[i - 1] && energies[i] >= energies[i + 1]) {
      const time = (i * hop) / sampleRate;
      if (!beats.length || time - beats[beats.length - 1] > 0.18) beats.push(time);
    }
  }
  return beats;
}

export function nearestBeat(time, beats, maxDelta = 0.15) {
  let best = null;
  let bestDist = maxDelta;
  for (const beat of beats || []) {
    const dist = Math.abs(beat - time);
    if (dist <= bestDist) {
      best = beat;
      bestDist = dist;
    }
  }
  return best == null ? time : best;
}
