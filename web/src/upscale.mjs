/** Tiled Real-ESRGAN compact (x4) in ONNX Runtime Web. One tile at a time. */

export function tileStarts(length, tile, overlap) {
  if (tile <= 0) throw new Error("tile must be positive");
  if (overlap < 0 || overlap >= tile) throw new Error("overlap must be >= 0 and < tile");
  if (length <= tile) return [0];
  const stride = tile - overlap;
  const starts = [];
  let pos = 0;
  while (pos < length) {
    const start = pos + tile <= length ? pos : length - tile;
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

function disposeTensor(tensor) {
  if (!tensor) return;
  const fn = tensor.dispose || tensor.delete;
  if (typeof fn === "function") {
    try {
      fn.call(tensor);
    } catch {
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

export function neuralInputSize(srcW, srcH, longSide) {
  const long = Math.max(srcW, srcH);
  const scale = long <= longSide ? 1 : longSide / long;
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  return { width: w, height: h };
}

export async function openEnhancer(ort, modelUrl) {
  if (!ort) throw new Error("The enhance engine did not load.");
  const wasmPaths = new URL("ort/", document.baseURI).href;
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const notes = [];
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        const info = adapter.info || {};
        return {
          session,
          backend: "webgpu",
          adapter: {
            vendor: info.vendor || "",
            architecture: info.architecture || "",
          },
          notes,
        };
      }
    } catch (err) {
      notes.push(String(err && err.message ? err.message : err));
    }
  }
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return { session, backend: "wasm", adapter: null, notes };
}

export async function upscaleRgb(ort, session, bytes, width, height, options = {}) {
  const modelScale = options.modelScale || 4;
  const targetScale = options.targetScale || 4;
  const tile = options.tile || 192;
  const overlap = options.overlap || 16;
  if (bytes.length !== width * height * 3) throw new Error("frame size does not match the picture");
  if (modelScale % targetScale !== 0) throw new Error("target scale must divide model scale");
  const downsample = modelScale / targetScale;
  const ys = tileStarts(height, tile, overlap);
  const xs = tileStarts(width, tile, overlap);
  if (ys.length * xs.length > 64) throw new Error("too many tiles for a phone frame");
  const fullW = width * targetScale;
  const fullH = height * targetScale;
  const acc = new Float32Array(fullW * fullH * 3);
  const weight = new Float32Array(fullW * fullH);
  const overlapTarget = overlap * targetScale;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  for (const y0 of ys) {
    const tileH = Math.min(tile, height - y0);
    for (const x0 of xs) {
      const tileW = Math.min(tile, width - x0);
      const input = new Float32Array(3 * tileH * tileW);
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < tileH; y++) {
          const row = ((y0 + y) * width + x0) * 3;
          for (let x = 0; x < tileW; x++) input[(c * tileH + y) * tileW + x] = bytes[row + x * 3 + c] / 255;
        }
      }
      const tensor = new ort.Tensor("float32", input, [1, 3, tileH, tileW]);
      let outputs = null;
      let outTensor = null;
      try {
        const feeds = {};
        feeds[inputName] = tensor;
        outputs = await session.run(feeds);
        outTensor = outputs[outputName];
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
          throw new Error("unexpected model output");
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
      }
      if (options.onTile) options.onTile();
    }
  }

  const out = new Uint8Array(fullW * fullH * 3);
  for (let i = 0; i < weight.length; i++) {
    const wgt = weight[i];
    if (!(wgt > 0)) throw new Error("tile coverage hole");
    const offset = i * 3;
    out[offset] = clampByte(acc[offset] / wgt);
    out[offset + 1] = clampByte(acc[offset + 1] / wgt);
    out[offset + 2] = clampByte(acc[offset + 2] / wgt);
  }
  return { rgb: out, width: fullW, height: fullH };
}
