/**
 * Download Kokoro ONNX model files into public/models for self-hosting
 * (GitHub Pages, offline use, etc.).
 *
 * Usage:
 *   node scripts/download-model.mjs              # q8 + config + all voices (~120MB)
 *   node scripts/download-model.mjs --fp32        # also download fp32 (~325MB extra)
 *   node scripts/download-model.mjs --q4          # also download q4
 *   node scripts/download-model.mjs --english-only-voices
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MODEL_DIR = path.join(
  ROOT,
  "public",
  "models",
  "onnx-community",
  "Kokoro-82M-v1.0-ONNX",
);
const HF_BASE =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

const args = new Set(process.argv.slice(2));
const wantFp32 = args.has("--fp32");
const wantQ4 = args.has("--q4");
const englishOnlyVoices = args.has("--english-only-voices");

const CORE_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx", // dtype: "q8"
];

if (wantFp32) CORE_FILES.push("onnx/model.onnx");
if (wantQ4) CORE_FILES.push("onnx/model_q4.onnx");

/** English voices used by the UI (American + British). */
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

const ALL_VOICES = [
  ...ENGLISH_VOICES,
  "ef_dora",
  "em_alex",
  "em_santa",
  "ff_siwis",
  "hf_alpha",
  "hf_beta",
  "hm_omega",
  "hm_psi",
  "if_sara",
  "im_nicola",
  "jf_alpha",
  "jf_gongitsune",
  "jf_nezumi",
  "jf_tebukuro",
  "jm_kumo",
  "pf_dora",
  "pm_alex",
  "pm_santa",
  "zf_xiaobei",
  "zf_xiaoni",
  "zf_xiaoxiao",
  "zf_xiaoyi",
  "zm_yunjian",
  "zm_yunxi",
  "zm_yunxia",
  "zm_yunyang",
];

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function fileExists(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function download(relPath) {
  const dest = path.join(MODEL_DIR, relPath);
  if (await fileExists(dest)) {
    const st = await fs.stat(dest);
    console.log(`  skip  ${relPath} (${formatBytes(st.size)} already present)`);
    return;
  }

  const url = `${HF_BASE}/${relPath}`;
  console.log(`  get   ${relPath}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed ${url}: ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader?.();
  await ensureDir(dest);

  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    console.log(`  done  ${relPath} (${formatBytes(buf.length)})`);
    return;
  }

  const chunks = [];
  let loaded = 0;
  let lastLog = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total && loaded - lastLog > total * 0.1) {
      lastLog = loaded;
      const pct = ((loaded / total) * 100).toFixed(0);
      process.stdout.write(
        `\r         ${pct}%  ${formatBytes(loaded)} / ${formatBytes(total)}   `,
      );
    }
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await fs.writeFile(dest, buf);
  if (total) process.stdout.write("\r" + " ".repeat(60) + "\r");
  console.log(`  done  ${relPath} (${formatBytes(buf.length)})`);
}

async function main() {
  const voices = englishOnlyVoices ? ENGLISH_VOICES : ALL_VOICES;
  const files = [
    ...CORE_FILES,
    ...voices.map((v) => `voices/${v}.bin`),
  ];

  console.log(`Target: ${MODEL_DIR}`);
  console.log(`Files:  ${files.length}`);
  console.log(
    `Extras: ${wantFp32 ? "fp32 " : ""}${wantQ4 ? "q4 " : ""}${englishOnlyVoices ? "english-voices" : "all-voices"}`,
  );
  console.log("");

  await fs.mkdir(MODEL_DIR, { recursive: true });

  for (const file of files) {
    await download(file);
  }

  // Marker so the app can detect a complete local install
  await fs.writeFile(
    path.join(MODEL_DIR, ".hosted"),
    JSON.stringify(
      {
        source: "onnx-community/Kokoro-82M-v1.0-ONNX",
        downloadedAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    ),
  );

  console.log("\nDone. Model is ready under public/models/");
  console.log("Commit with Git LFS (see README) before pushing to GitHub.");
}

main().catch((err) => {
  console.error("\nDownload failed:", err.message || err);
  process.exit(1);
});
