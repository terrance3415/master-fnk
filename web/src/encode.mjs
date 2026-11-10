/** Mux canvas frames and optional music into an MP4. H.264, not AV1. */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

function videoCodecs(width, height) {
  const codecs = [];
  if (width <= 1280 && height <= 720) codecs.push("avc1.42001f", "avc1.4d001f", "avc1.64001f");
  if (width <= 1920 && height <= 1088) codecs.push("avc1.420028", "avc1.4d0028", "avc1.640028", "avc1.640029");
  codecs.push("avc1.640032", "avc1.640033", "avc1.640034");
  return codecs;
}

async function supportedVideoConfig(width, height, bitrate, fps) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
    for (const codec of videoCodecs(width, height)) {
      const config = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        avc: { format: "avc" },
        hardwareAcceleration,
        latencyMode: "realtime",
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return support.config || config;
      } catch {
        /* try the next profile */
      }
    }
  }
  return null;
}

async function supportedAudioConfig() {
  if (typeof AudioEncoder === "undefined") return null;
  const candidates = [
    { mux: "aac", codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
    { mux: "aac", codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 },
    { mux: "opus", codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 },
  ];
  for (const candidate of candidates) {
    const config = {
      codec: candidate.codec,
      sampleRate: candidate.sampleRate,
      numberOfChannels: candidate.numberOfChannels,
      bitrate: candidate.bitrate,
    };
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported) return { mux: candidate.mux, config: support.config || config };
    } catch {
      /* try the next codec */
    }
  }
  return null;
}

function audioData(rendered, frameStart, frameCount) {
  const channels = rendered.numberOfChannels;
  const planar = new Float32Array(channels * frameCount);
  for (let c = 0; c < channels; c++) {
    planar.set(rendered.getChannelData(c).subarray(frameStart, frameStart + frameCount), c * frameCount);
  }
  return new AudioData({
    format: "f32-planar",
    sampleRate: rendered.sampleRate,
    numberOfFrames: frameCount,
    numberOfChannels: channels,
    timestamp: Math.round((frameStart / rendered.sampleRate) * 1e6),
    data: planar,
  });
}

export async function encodeCanvasFilm({ canvas, fps, bitrate, frameCount, audioBuffer, signal, draw }) {
  const width = canvas.width;
  const height = canvas.height;
  if (width < 1280 || height < 720) throw new Error("refusing to save below 720p");
  const videoConfig = await supportedVideoConfig(width, height, bitrate, fps);
  if (!videoConfig) {
    throw new Error(
      "This phone’s browser cannot save a finished video. On Android, open this page in Chrome. On iPhone, update to iOS 17 or newer and use Safari.",
    );
  }
  let audioNote = "none";
  let renderedAudio = null;
  let audioChoice = null;
  if (audioBuffer) {
    audioChoice = await supportedAudioConfig();
    if (!audioChoice) audioNote = "music-skipped";
    else {
      try {
        const rate = audioChoice.config.sampleRate;
        const length = Math.ceil((frameCount / fps) * rate);
        const offline = new OfflineAudioContext(2, Math.max(1, length), rate);
        const source = offline.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = true;
        source.connect(offline.destination);
        source.start(0);
        renderedAudio = await offline.startRendering();
        audioNote = audioChoice.mux;
      } catch {
        renderedAudio = null;
        audioChoice = null;
        audioNote = "music-skipped";
      }
    }
  }
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height, frameRate: fps },
    audio:
      audioChoice && renderedAudio
        ? {
            codec: audioChoice.mux,
            numberOfChannels: audioChoice.config.numberOfChannels,
            sampleRate: audioChoice.config.sampleRate,
          }
        : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let videoError = null;
  let audioError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      videoError = err;
    },
  });
  videoEncoder.configure(videoConfig);
  let audioEncoder = null;
  if (audioChoice && renderedAudio) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => {
        audioError = err;
      },
    });
    audioEncoder.configure(audioChoice.config);
  }

  const frameDuration = Math.round(1e6 / fps);
  for (let index = 0; index < frameCount; index++) {
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    if (videoError) throw videoError;
    await draw(index);
    const frame = new VideoFrame(canvas, {
      timestamp: index * frameDuration,
      duration: frameDuration,
    });
    videoEncoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
    frame.close();
    while (videoEncoder.encodeQueueSize > 6) {
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  }
  await videoEncoder.flush();
  if (videoError) throw videoError;
  videoEncoder.close();

  if (audioEncoder && renderedAudio) {
    const packet = 1024;
    for (let offset = 0; offset < renderedAudio.length; offset += packet) {
      const count = Math.min(packet, renderedAudio.length - offset);
      const data = audioData(renderedAudio, offset, count);
      audioEncoder.encode(data);
      data.close();
    }
    await audioEncoder.flush();
    if (audioError) {
      audioNote = "music-skipped";
    }
    audioEncoder.close();
  }
  muxer.finalize();
  const blob = new Blob([target.buffer], { type: "video/mp4" });
  return { blob, audio: audioNote, width, height, frames: frameCount };
}
