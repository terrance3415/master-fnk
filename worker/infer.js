/*
 * Local ONNX Runtime Web worker for the compact Real-ESRGAN model.
 * Assets are loaded from this page's loopback origin only. No CDN, no telemetry.
 * WebGPU and WASM are separate execution providers. This file never lists both
 * in one session and never switches from a failed WebGPU session to WASM.
 */
(function (root) {
  "use strict";

  function webgpuHelp(detail) {
    return [
      "WebGPU backend is unavailable (" + detail + ").",
      "The worker will not fall back to WASM. Re-run with --backend wasm only when you explicitly want the CPU test path.",
      "Install Google Chrome 113 or newer.",
      "Open chrome://gpu and confirm WebGPU is available. If chrome://flags shows WebGPU disabled, set it to Enabled and relaunch Chrome.",
      "Linux needs a working Vulkan driver so Chrome can create an adapter. Windows needs a current GPU driver.",
      "An RTX 3060 can run this WebGPU path. It does not have a hardware AV1 encoder; video is still encoded with libsvtav1 on the CPU.",
      "A machine with no GPU adapter cannot run --backend webgpu.",
    ].join(" ");
  }

  function tileStarts(length, tile, overlap) {
    if (tile <= 0) throw new Error("tile must be positive");
    if (overlap < 0 || overlap >= tile) throw new Error("overlap must be >= 0 and < tile");
    if (length <= tile) return [0];
    const stride = tile - overlap;
    const starts = [];
    let pos = 0;
    while (pos < length) {
      let start = pos + tile <= length ? pos : length - tile;
      if (starts.length && starts[starts.length - 1] === start) break;
      starts.push(start);
      if (start + tile >= length) break;
      pos += stride;
    }
    return starts;
  }

  function featherWeight(globalX, globalY, tileX, tileY, tileW, tileH, fullW, fullH, overlap) {
    if (overlap <= 0) return 1;
    const localX = globalX - tileX;
    const localY = globalY - tileY;
    let wx = 1;
    let wy = 1;
    if (tileX > 0) wx = Math.min(wx, (localX + 0.5) / overlap);
    if (tileX + tileW < fullW) wx = Math.min(wx, (tileW - localX - 0.5) / overlap);
    if (tileY > 0) wy = Math.min(wy, (localY + 0.5) / overlap);
    if (tileY + tileH < fullH) wy = Math.min(wy, (tileH - localY - 0.5) / overlap);
    return Math.max(0, wx) * Math.max(0, wy);
  }

  function coverageMinimum(width, height, tile, overlap) {
    const acc = new Float32Array(width * height);
    const ys = tileStarts(height, tile, overlap);
    const xs = tileStarts(width, tile, overlap);
    for (const y0 of ys) {
      const tileH = Math.min(tile, height - y0);
      for (const x0 of xs) {
        const tileW = Math.min(tile, width - x0);
        for (let y = 0; y < tileH; y++) {
          for (let x = 0; x < tileW; x++) {
            acc[(y0 + y) * width + (x0 + x)] += featherWeight(
              x0 + x,
              y0 + y,
              x0,
              y0,
              tileW,
              tileH,
              width,
              height,
              overlap
            );
          }
        }
      }
    }
    let min = Infinity;
    for (let i = 0; i < acc.length; i++) min = Math.min(min, acc[i]);
    return min;
  }

  function disposeTensor(tensor) {
    if (!tensor) return;
    const fn = tensor.dispose || tensor.delete;
    if (typeof fn === "function") {
      try {
        fn.call(tensor);
      } catch (err) {
        /* already released */
      }
    }
  }

  function clampByte(value) {
    const rounded = Math.round(value * 255);
    if (rounded < 0) return 0;
    if (rounded > 255) return 255;
    return rounded;
  }

  const state = {
    session: null,
    config: null,
    inputName: "input",
    outputName: "output",
    wasmPaths: "",
  };

  async function initModel(config) {
    if (!root.ort) {
      throw new Error("onnxruntime-web did not load from /ort/ort.all.min.js");
    }
    const backend = config.backend;
    if (backend !== "webgpu" && backend !== "wasm") {
      throw new Error("unsupported backend " + backend);
    }
    const wasmPaths = new URL("ort/", root.location.href).href;
    root.ort.env.wasm.wasmPaths = wasmPaths;
    root.ort.env.wasm.numThreads = 1;
    root.ort.env.wasm.proxy = false;
    state.wasmPaths = wasmPaths;
    let executionProviders;
    let adapterInfo = null;
    if (backend === "webgpu") {
      if (!root.navigator.gpu) {
        throw new Error(webgpuHelp("navigator.gpu is missing"));
      }
      let adapter = null;
      try {
        adapter = await root.navigator.gpu.requestAdapter();
      } catch (err) {
        throw new Error(webgpuHelp(String(err)));
      }
      if (!adapter) {
        throw new Error(webgpuHelp("requestAdapter() returned null"));
      }
      const info = adapter.info || {};
      adapterInfo = {
        vendor: info.vendor || "",
        architecture: info.architecture || "",
        device: info.device || "",
        description: info.description || "",
        isFallbackAdapter: Boolean(adapter.isFallbackAdapter),
      };
      executionProviders = ["webgpu"];
    } else {
      executionProviders = ["wasm"];
    }
    const session = await root.ort.InferenceSession.create(new URL("model.onnx", root.location.href).href, {
      executionProviders: executionProviders,
      graphOptimizationLevel: "all",
    });
    state.session = session;
    state.config = {
      backend: backend,
      tile: config.tile,
      overlap: config.overlap,
      modelScale: config.modelScale,
      targetScale: config.targetScale,
    };
    state.inputName = session.inputNames[0];
    state.outputName = session.outputNames[0];
    return {
      backend: backend,
      executionProviders: executionProviders,
      inputName: state.inputName,
      outputName: state.outputName,
      wasmPaths: wasmPaths,
      adapter: adapterInfo,
    };
  }

  function setGeometry(tile, overlap, targetScale) {
    if (!state.config) throw new Error("model is not initialized");
    state.config.tile = tile;
    state.config.overlap = overlap;
    state.config.targetScale = targetScale;
  }

  async function upscaleRgb(bytes, width, height) {
    const session = state.session;
    const config = state.config;
    if (!session || !config) throw new Error("model is not initialized");
    if (bytes.length !== width * height * 3) {
      throw new Error("frame byte length does not match width and height");
    }
    const modelScale = config.modelScale;
    const targetScale = config.targetScale;
    if (modelScale % targetScale !== 0) {
      throw new Error("target scale must divide model scale");
    }
    const downsample = modelScale / targetScale;
    const tile = config.tile;
    const overlap = config.overlap;
    const ys = tileStarts(height, tile, overlap);
    const xs = tileStarts(width, tile, overlap);
    if (ys.length * xs.length > 4096) {
      throw new Error("too many tiles; increase tile or reduce overlap");
    }
    const fullW = width * targetScale;
    const fullH = height * targetScale;
    const acc = new Float32Array(fullW * fullH * 3);
    const weight = new Float32Array(fullW * fullH);
    const overlapTarget = overlap * targetScale;

    for (const y0 of ys) {
      const tileH = Math.min(tile, height - y0);
      for (const x0 of xs) {
        const tileW = Math.min(tile, width - x0);
        const input = new Float32Array(3 * tileH * tileW);
        for (let c = 0; c < 3; c++) {
          for (let y = 0; y < tileH; y++) {
            const row = ((y0 + y) * width + x0) * 3;
            for (let x = 0; x < tileW; x++) {
              input[(c * tileH + y) * tileW + x] = bytes[row + x * 3 + c] / 255;
            }
          }
        }
        const tensor = new root.ort.Tensor("float32", input, [1, 3, tileH, tileW]);
        let outputs = null;
        let outTensor = null;
        try {
          const feeds = {};
          feeds[state.inputName] = tensor;
          outputs = await session.run(feeds);
          outTensor = outputs[state.outputName];
          let data = outTensor.data;
          if (data && typeof data.then === "function") data = await data;
          const dims = outTensor.dims.map((value) => Number(value));
          let layout;
          let modelH;
          let modelW;
          if (dims.length === 4 && dims[1] === 3) {
            layout = "nchw";
            modelH = dims[2];
            modelW = dims[3];
          } else if (dims.length === 4 && dims[3] === 3) {
            layout = "nhwc";
            modelH = dims[1];
            modelW = dims[2];
          } else {
            throw new Error("unexpected output dims " + dims.join("x"));
          }
          if (modelH !== tileH * modelScale || modelW !== tileW * modelScale) {
            throw new Error("model output " + modelW + "x" + modelH + " does not match x" + modelScale);
          }
          const originX = x0 * targetScale;
          const originY = y0 * targetScale;
          const tileOutW = tileW * targetScale;
          const tileOutH = tileH * targetScale;
          const area = downsample * downsample;
          for (let ly = 0; ly < tileOutH; ly++) {
            for (let lx = 0; lx < tileOutW; lx++) {
              let red = 0;
              let green = 0;
              let blue = 0;
              const yBase = ly * downsample;
              const xBase = lx * downsample;
              for (let dy = 0; dy < downsample; dy++) {
                for (let dx = 0; dx < downsample; dx++) {
                  const yy = yBase + dy;
                  const xx = xBase + dx;
                  if (layout === "nchw") {
                    red += data[(0 * modelH + yy) * modelW + xx];
                    green += data[(1 * modelH + yy) * modelW + xx];
                    blue += data[(2 * modelH + yy) * modelW + xx];
                  } else {
                    const base = (yy * modelW + xx) * 3;
                    red += data[base];
                    green += data[base + 1];
                    blue += data[base + 2];
                  }
                }
              }
              red /= area;
              green /= area;
              blue /= area;
              const gx = originX + lx;
              const gy = originY + ly;
              const wgt = featherWeight(gx, gy, originX, originY, tileOutW, tileOutH, fullW, fullH, overlapTarget);
              const offset = (gy * fullW + gx) * 3;
              acc[offset] += red * wgt;
              acc[offset + 1] += green * wgt;
              acc[offset + 2] += blue * wgt;
              weight[gy * fullW + gx] += wgt;
            }
          }
        } finally {
          disposeTensor(tensor);
          disposeTensor(outTensor);
          outputs = null;
          outTensor = null;
        }
      }
    }

    const out = new Uint8Array(fullW * fullH * 3);
    for (let i = 0; i < weight.length; i++) {
      const wgt = weight[i];
      if (!(wgt > 0)) throw new Error("tile coverage hole at pixel " + i);
      const offset = i * 3;
      out[offset] = clampByte(acc[offset] / wgt);
      out[offset + 1] = clampByte(acc[offset + 1] / wgt);
      out[offset + 2] = clampByte(acc[offset + 2] / wgt);
    }
    return out;
  }

  async function processCurrent() {
    const response = await root.fetch("/frame.bin", { cache: "no-store" });
    if (!response.ok) throw new Error("frame fetch failed (" + response.status + ")");
    const width = Number(response.headers.get("X-Width"));
    const height = Number(response.headers.get("X-Height"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    const out = await upscaleRgb(bytes, width, height);
    const posted = await root.fetch("/result.bin", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: out,
    });
    if (!posted.ok && posted.status !== 204) throw new Error("result post failed (" + posted.status + ")");
    return { width: width * state.config.targetScale, height: height * state.config.targetScale, bytes: out.byteLength };
  }

  async function shutdown() {
    const session = state.session;
    state.session = null;
    if (session && typeof session.release === "function") {
      try {
        await session.release();
      } catch (err) {
        /* closing */
      }
    }
  }

  const api = {
    tileStarts: tileStarts,
    featherWeight: featherWeight,
    coverageMinimum: coverageMinimum,
    initModel: initModel,
    setGeometry: setGeometry,
    processCurrent: processCurrent,
    shutdown: shutdown,
    webgpuHelp: webgpuHelp,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root.document !== "undefined") {
    root.RemasterWorker = api;
    root.initModel = initModel;
    root.setGeometry = setGeometry;
    root.processCurrent = processCurrent;
    root.shutdown = shutdown;
    root.workerReady = true;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
