/**
 * Download a catalog model key into public/models/ (for CI / local use).
 *
 * Usage:
 *   node scripts/download-model-for-key.mjs kokoro-v1-balanced
 *   node scripts/download-model-for-key.mjs kokoro-v1-quality
 *   node scripts/download-model-for-key.mjs kokoro-v1-compact
 *   node scripts/download-model-for-key.mjs kokoro-original
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_MODELS = path.join(ROOT, "public", "models");

/** Mirror of src/modelCatalog.js (kept in sync manually for Node CI). */
const CATALOG = {
  "kokoro-v1-balanced": {
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    onnx: ["onnx/model_quantized.onnx"],
    voices: "english",
  },
  "kokoro-v1-quality": {
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    onnx: ["onnx/model.onnx", "onnx/model_quantized.onnx"],
    voices: "english",
  },
  "kokoro-v1-compact": {
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    onnx: ["onnx/model_q4.onnx", "onnx/model_quantized.onnx"],
    voices: "english",
  },
  "kokoro-original": {
    modelId: "onnx-community/Kokoro-82M-ONNX",
    onnx: ["onnx/model_quantized.onnx"],
    voices: "none",
  },
};

const ENGLISH_VOICES = [
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_heart",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
];

const CORE = ["config.json", "tokenizer.json", "tokenizer_config.json"];

const key = (process.argv[2] || "").trim();
if (!key || !CATALOG[key]) {
  console.error(
    `Usage: node scripts/download-model-for-key.mjs <key>\nKeys: ${Object.keys(CATALOG).join(", ")}`,
  );
  process.exit(1);
}

const entry = CATALOG[key];
const modelDir = path.join(PUBLIC_MODELS, ...entry.modelId.split("/"));
const hfBase = `https://huggingface.co/${entry.modelId}/resolve/main`;

const files = [
  ...CORE,
  ...entry.onnx,
  ...(entry.voices === "english"
    ? ENGLISH_VOICES.map((v) => `voices/${v}.bin`)
    : []),
];

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function fileOk(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function download(rel) {
  const dest = path.join(modelDir, rel);
  if (await fileOk(dest)) {
    const st = await fs.stat(dest);
    console.log(`  skip  ${rel} (${formatBytes(st.size)})`);
    return;
  }
  const url = `${hfBase}/${rel}`;
  console.log(`  get   ${rel}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`  done  ${rel} (${formatBytes(buf.length)})`);
}

console.log(`Model key: ${key}`);
console.log(`Target:    ${modelDir}`);
console.log(`Files:     ${files.length}\n`);

await fs.mkdir(modelDir, { recursive: true });
for (const f of files) await download(f);

await fs.writeFile(
  path.join(modelDir, ".hosted"),
  JSON.stringify(
    {
      key,
      source: entry.modelId,
      downloadedAt: new Date().toISOString(),
      files,
    },
    null,
    2,
  ),
);

console.log("\nDone.");
