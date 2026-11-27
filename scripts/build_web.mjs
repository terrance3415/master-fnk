import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "dist-web");
const ortSrc = path.join(root, "node_modules", "onnxruntime-web", "dist");
const ortFiles = [
  "ort.all.min.js",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "ort"), { recursive: true });
await mkdir(path.join(out, "models"), { recursive: true });
await mkdir(path.join(out, "icons"), { recursive: true });

await build({
  entryPoints: [path.join(root, "web", "src", "main.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(out, "app.js"),
  minify: true,
  target: "es2022",
  legalComments: "none",
});

for (const name of ["index.html", "styles.css", "manifest.webmanifest"]) {
  await cp(path.join(root, "web", name), path.join(out, name));
}
await cp(path.join(root, "web", "icons"), path.join(out, "icons"), { recursive: true });
await cp(path.join(root, "web", "v17"), path.join(out, "v17"), { recursive: true });
for (const name of [
  "realesr-general-x4v3.onnx",
  "mobileclip-s0-vision.onnx",
  "mobileclip-tags.json",
  "yamnet.onnx",
  "tagger-manifest.json",
]) {
  await cp(path.join(root, "models", name), path.join(out, "models", name));
}
for (const name of ortFiles) {
  await cp(path.join(ortSrc, name), path.join(out, "ort", name));
}

const version = `fnk-${new Date().toISOString().slice(0, 10)}-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`;
const precache = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/v17-lightning.png",
  "./icons/v17-lightning-180.png",
  "./v17/splash-screen.png",
  ...["home-recolor-jean.png", "home-recolor-rogue.png", "home-recolor-storm.png",
    "share-rogue-green.png", "vault-storm-locked.png", "vault-storm-open.png"].map((name) => `./v17/${name}`),
  ...["bg_video_jean.jpg", "bg_music_rogue.jpg", "bg_captured_storm.jpg", "bg_export_trio.jpg",
    "fig_jean_flying.png", "fig_jean_landed.png", "fig_rogue_flying.png", "fig_rogue_landed.png",
    "fig_storm_flying.png", "fig_storm_landed.png", "fig_trio_flying.png"].map((name) => `./v17/${name}`),
];
const template = await readFile(path.join(root, "web", "sw.js"), "utf8");
const sw = template
  .replaceAll("__CACHE__", version)
  .replace("__PRECACHE_JSON__", JSON.stringify(precache, null, 2));
await writeFile(path.join(out, "sw.js"), sw);
await writeFile(path.join(out, ".nojekyll"), "");
console.log(`built ${out} (${version})`);
