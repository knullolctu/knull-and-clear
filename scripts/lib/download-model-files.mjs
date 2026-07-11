/**
 * Shared downloader: writes HF model files into public/models.
 * Used by CLI script and Vite /api/download-model.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_MODELS = path.join(ROOT, "public", "models");

export const ENGLISH_VOICES = [
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

/** @param {string} dtype */
export function onnxRelPath(dtype) {
  switch (dtype) {
    case "fp32":
      return "onnx/model.onnx";
    case "fp16":
      return "onnx/model_fp16.onnx";
    case "q4":
      return "onnx/model_q4.onnx";
    case "q4f16":
      return "onnx/model_q4f16.onnx";
    case "q8":
    default:
      return "onnx/model_quantized.onnx";
  }
}

/**
 * Files needed so a catalog entry can run offline.
 * @param {{ modelId: string, dtype: string, localVoices?: boolean }} entry
 * @param {{ includeVoices?: boolean }} [opts]
 */
export function planFilesForEntry(entry, opts = {}) {
  const includeVoices = opts.includeVoices !== false;
  const files = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    onnxRelPath(entry.dtype),
  ];
  // Always ensure q8 exists as runtime fallback for non-q8 picks
  if (entry.dtype !== "q8") {
    files.push(onnxRelPath("q8"));
  }
  if (includeVoices && entry.localVoices !== false) {
    for (const v of ENGLISH_VOICES) files.push(`voices/${v}.bin`);
  }
  return { modelId: entry.modelId, files: [...new Set(files)] };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function fileExists(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} modelId
 * @param {string} relPath
 * @param {(ev: object) => void} [onProgress]
 */
async function downloadOne(modelId, relPath, onProgress) {
  const dest = path.join(PUBLIC_MODELS, modelId, relPath);
  if (await fileExists(dest)) {
    const st = await fs.stat(dest);
    onProgress?.({
      type: "skip",
      file: relPath,
      total: st.size,
      message: `Already present (${formatBytes(st.size)})`,
    });
    return { skipped: true, bytes: st.size };
  }

  const url = `https://huggingface.co/${modelId}/resolve/main/${relPath}`;
  onProgress?.({
    type: "start",
    file: relPath,
    message: `Downloading ${relPath}…`,
  });

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed ${url}: ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get("content-length")) || 0;
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    onProgress?.({
      type: "file-done",
      file: relPath,
      loaded: buf.length,
      total: buf.length,
      message: `Done ${relPath} (${formatBytes(buf.length)})`,
    });
    return { skipped: false, bytes: buf.length };
  }

  const chunks = [];
  let loaded = 0;
  let lastEmit = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - lastEmit > Math.max(total * 0.02, 256 * 1024) || loaded === total) {
      lastEmit = loaded;
      onProgress?.({
        type: "progress",
        file: relPath,
        loaded,
        total,
        message: total
          ? `${relPath}: ${formatBytes(loaded)} / ${formatBytes(total)}`
          : `${relPath}: ${formatBytes(loaded)}`,
      });
    }
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await fs.writeFile(dest, buf);
  onProgress?.({
    type: "file-done",
    file: relPath,
    loaded: buf.length,
    total: buf.length,
    message: `Done ${relPath} (${formatBytes(buf.length)})`,
  });
  return { skipped: false, bytes: buf.length };
}

/**
 * @param {{ modelId: string, files: string[] }} plan
 * @param {(ev: object) => void} [onProgress]
 */
export async function downloadModelPlan(plan, onProgress) {
  const { modelId, files } = plan;
  const modelDir = path.join(PUBLIC_MODELS, modelId);
  await fs.mkdir(modelDir, { recursive: true });

  onProgress?.({
    type: "plan",
    modelId,
    files,
    message: `Downloading ${files.length} file(s) for ${modelId}`,
  });

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.({
      type: "file-index",
      index: i + 1,
      count: files.length,
      file,
    });
    const result = await downloadOne(modelId, file, onProgress);
    if (result.skipped) skipped += 1;
    else downloaded += 1;
  }

  await fs.writeFile(
    path.join(modelDir, ".hosted"),
    JSON.stringify(
      {
        source: modelId,
        downloadedAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    ),
  );

  onProgress?.({
    type: "done",
    modelId,
    downloaded,
    skipped,
    message: `Complete — ${downloaded} new, ${skipped} already present`,
  });

  return { modelId, downloaded, skipped, dir: modelDir };
}

export { PUBLIC_MODELS, ROOT, formatBytes };
