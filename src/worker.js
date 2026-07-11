import { KokoroTTS } from "kokoro-js";
// Use Transformers.js env directly — kokoro-js re-exports a thin subset only.
import { env } from "@huggingface/transformers";
import {
  DEFAULT_MODEL_KEY,
  getModelEntry,
} from "./modelCatalog.js";

/**
 * Local model folder (Vite serves /public at site root).
 * When hosted on GitHub Pages at /repo-name/, BASE_URL is "/repo-name/".
 */
const BASE_URL = import.meta.env.BASE_URL || "/";
const LOCAL_MODEL_PATH = new URL("models/", self.location.origin + BASE_URL)
  .pathname.replace(/\/?$/, "/");
/** Shared English voice packs live next to the v1 model. */
const V1_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const V1_VOICES_BASE = new URL(
  `models/${V1_MODEL_ID}/`,
  self.location.origin + BASE_URL,
).pathname.replace(/\/?$/, "/");

// Local / self-hosted only — never load weights from Hugging Face at runtime
env.allowLocalModels = true;
env.localModelPath = LOCAL_MODEL_PATH;
env.allowRemoteModels = false;
// Corrupt / partial Cache API entries are a common cause of loads that stall
// after tokenizer files with no further progress. Prefer re-reading local files.
env.useBrowserCache = false;

/**
 * Single-threaded ORT wasm. Dev: same-origin node_modules. Prod (Pages): CDN.
 * Multi-threaded WASM + COEP can hang after tokenizer with no further events.
 */
function configureOrtWasm() {
  try {
    const onnxEnv = env.backends?.onnx;
    if (!onnxEnv?.wasm) return;
    onnxEnv.wasm.numThreads = 1;
    onnxEnv.wasm.proxy = false;
    if (import.meta.env.DEV) {
      onnxEnv.wasm.wasmPaths = `${self.location.origin}/node_modules/@huggingface/transformers/dist/`;
    } else {
      // GitHub Pages has no node_modules — use jsDelivr (sends CORP for COEP)
      onnxEnv.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${env.version}/dist/`;
    }
  } catch (e) {
    console.warn("ORT wasm config failed", e);
  }
}

/** @type {FileSystemDirectoryHandle | null} */
let modelLibraryRoot = null;

/** Cache: modelId → pack directory handle (nested scan result) */
const packDirCache = new Map();

/**
 * @param {string} relativePath path under library root
 */
async function readLibraryAbsolute(relativePath) {
  if (!modelLibraryRoot) return null;
  try {
    const parts = relativePath.split("/").filter(Boolean);
    let dir = modelLibraryRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();
    if (!file.size) return null;
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * A model pack: tokenizer + config + onnx weights (any nesting under library).
 * @param {FileSystemDirectoryHandle} dir
 */
async function isPackDir(dir) {
  let hasConfig = false;
  let hasTokenizer = false;
  let hasOnnx = false;
  try {
    await dir.getFileHandle("config.json");
    hasConfig = true;
  } catch {
    /* optional soft */
  }
  try {
    await dir.getFileHandle("tokenizer.json");
    hasTokenizer = true;
  } catch {
    /* optional soft */
  }
  try {
    const onnx = await dir.getDirectoryHandle("onnx");
    for await (const [name, h] of onnx.entries()) {
      if (h.kind === "file" && name.endsWith(".onnx")) {
        hasOnnx = true;
        break;
      }
    }
  } catch {
    /* no onnx dir */
  }
  // Also accept .onnx sitting next to config (rare)
  if (!hasOnnx) {
    try {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === "file" && name.endsWith(".onnx")) {
          hasOnnx = true;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Need weights + at least one of the json sidecars
  return hasOnnx && (hasConfig || hasTokenizer);
}

/**
 * List every pack under the library root (nested).
 * @returns {Promise<{ path: string, name: string, handle: FileSystemDirectoryHandle }[]>}
 */
async function listAllPacks() {
  if (!modelLibraryRoot) return [];
  /** @type {{ path: string, name: string, handle: FileSystemDirectoryHandle }[]} */
  const packs = [];
  const maxDepth = 10;

  /**
   * @param {FileSystemDirectoryHandle} dir
   * @param {string} rel
   * @param {number} depth
   */
  async function walk(dir, rel, depth) {
    if (depth > maxDepth) return;
    if (await isPackDir(dir)) {
      const name = rel ? rel.split("/").pop() || rel : dir.name;
      packs.push({ path: rel || name, name, handle: dir });
      return; // don't walk inside a pack
    }
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "directory") continue;
        if (
          name === "node_modules" ||
          name === ".git" ||
          name === "dist" ||
          name.startsWith(".")
        ) {
          continue;
        }
        await walk(handle, rel ? `${rel}/${name}` : name, depth + 1);
      }
    } catch {
      /* ignore */
    }
  }

  await walk(modelLibraryRoot, "", 0);
  return packs;
}

/**
 * Score how well a discovered pack path matches a modelId.
 * @param {string} packPath
 * @param {string} packName
 * @param {string} modelId
 */
function packMatchScore(packPath, packName, modelId) {
  const id = modelId.replace(/^\/+|\/+$/g, "");
  const short = id.split("/").pop() || id;
  const path = (packPath || "").replace(/\\/g, "/");
  const name = packName || "";
  let score = 0;
  if (path === id || path === `models/${id}`) score += 100;
  if (path.endsWith(`/${id}`) || path.endsWith(id)) score += 80;
  if (path.includes(id)) score += 50;
  if (name === short || name.toLowerCase() === short.toLowerCase()) score += 40;
  if (path.toLowerCase().includes(short.toLowerCase())) score += 25;
  // org segment
  const org = id.split("/")[0];
  if (org && path.includes(org)) score += 10;
  if (/kokoro/i.test(name) && /kokoro/i.test(short)) score += 15;
  return score;
}

/**
 * Find pack dir for modelId under nested folders (cached).
 * @param {string} modelId
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
async function resolvePackDir(modelId) {
  if (!modelLibraryRoot) return null;
  if (packDirCache.has(modelId)) return packDirCache.get(modelId);

  const id = String(modelId || "").replace(/^\/+|\/+$/g, "");
  const short = id.split("/").pop() || id;

  const tryRel = async (rel) => {
    try {
      const parts = rel.split("/").filter(Boolean);
      let dir = modelLibraryRoot;
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      if (await isPackDir(dir)) return dir;
    } catch {
      /* miss */
    }
    return null;
  };

  // Fast exact relative paths
  for (const rel of [
    `models/${id}`,
    id,
    `models/${short}`,
    short,
    // user picked the pack folder itself
    "",
  ]) {
    if (rel === "") {
      if (await isPackDir(modelLibraryRoot)) {
        packDirCache.set(modelId, modelLibraryRoot);
        return modelLibraryRoot;
      }
      continue;
    }
    const hit = await tryRel(rel);
    if (hit) {
      packDirCache.set(modelId, hit);
      return hit;
    }
  }

  // Deep scan + best match
  const packs = await listAllPacks();
  if (packs.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of packs) {
    const s = packMatchScore(p.path, p.name, id);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }

  // Only accept a reasonable match, or the sole pack in the library
  if (best && (bestScore >= 25 || packs.length === 1)) {
    packDirCache.set(modelId, best.handle);
    return best.handle;
  }
  return null;
}

/**
 * Read a file relative to a pack directory handle.
 * @param {FileSystemDirectoryHandle} pack
 * @param {string} fileRel
 */
async function readFromPack(pack, fileRel) {
  try {
    const parts = String(fileRel).replace(/^\/+/, "").split("/").filter(Boolean);
    let dir = pack;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    const f = await fh.getFile();
    if (!f.size) return null;
    return await f.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Read from library: fixed models/ path, then nested pack locate.
 * @param {string} modelId
 * @param {string} fileRel
 */
async function readFromModelLibrary(modelId, fileRel) {
  if (!modelLibraryRoot) return null;
  const file = String(fileRel || "").replace(/^\/+/, "");
  const id = String(modelId || "").replace(/^\/+|\/+$/g, "");
  const short = id.split("/").pop() || id;

  for (const rel of [
    `models/${id}/${file}`,
    `${id}/${file}`,
    `models/${short}/${file}`,
    `${short}/${file}`,
    file, // root is the pack
  ]) {
    const buf = await readLibraryAbsolute(rel.replace(/\/+/g, "/"));
    if (buf) return buf;
  }

  const pack = await resolvePackDir(modelId);
  if (!pack) return null;
  return readFromPack(pack, file);
}

/**
 * Path from site URL /models/{modelId}/… → library (nested-aware)
 * @param {string} fullRel e.g. onnx-community/…/onnx/file.onnx
 */
async function readFromModelLibraryPath(fullRel) {
  if (!modelLibraryRoot || !fullRel) return null;
  let cleaned = String(fullRel).replace(/^\/+/, "");
  if (cleaned.startsWith("models/")) cleaned = cleaned.slice("models/".length);

  const parts = cleaned.split("/").filter(Boolean);
  const onnxIdx = parts.indexOf("onnx");
  const voicesIdx = parts.indexOf("voices");
  const cut = onnxIdx >= 0 ? onnxIdx : voicesIdx >= 0 ? voicesIdx : -1;
  if (cut > 0) {
    const modelId = parts.slice(0, cut).join("/");
    const fileRel = parts.slice(cut).join("/");
    return readFromModelLibrary(modelId, fileRel);
  }
  if (parts.length >= 2) {
    const fileRel = parts[parts.length - 1];
    const modelId = parts.slice(0, -1).join("/");
    const buf = await readFromModelLibrary(modelId, fileRel);
    if (buf) return buf;
  }
  return (
    (await readLibraryAbsolute(`models/${cleaned}`)) ||
    (await readLibraryAbsolute(cleaned))
  );
}

function libraryResponse(buf, contentType = "application/octet-stream") {
  return new Response(buf.slice(0), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Content-Length": String(buf.byteLength),
    },
  });
}

/** Active model selection (mutable — user can switch at runtime). */
let activeModelKey = DEFAULT_MODEL_KEY;
let activeModel = getModelEntry(activeModelKey);
let MODEL_ID = activeModel.modelId;
let MODEL_BASE = new URL(
  `models/${MODEL_ID}/`,
  self.location.origin + BASE_URL,
).pathname.replace(/\/?$/, "/");

function applyModelSelection(modelKey) {
  activeModelKey = modelKey || DEFAULT_MODEL_KEY;
  activeModel = getModelEntry(activeModelKey);
  MODEL_ID = activeModel.modelId;
  MODEL_BASE = new URL(
    `models/${MODEL_ID}/`,
    self.location.origin + BASE_URL,
  ).pathname.replace(/\/?$/, "/");
}

/**
 * kokoro-js hardcodes Hugging Face URLs for voice .bin files in the browser.
 * Rewrite those requests to our self-hosted copies under /models/.../voices/.
 *
 * Style vectors are 256 float32s; an empty/204 response yields
 * "Tensor's size(256) does not match data length(0)".
 */
const HF_VOICE_RE =
  /https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/voices\/([^/?#]+\.bin)/i;
/** Minimum bytes for one style row (256 × float32). Real files are ~510 KB. */
const MIN_VOICE_BYTES = 256 * 4;

const originalFetch = self.fetch.bind(self);

/** In-memory voice bytes — one fetch per voice per session. */
const voiceMemory = new Map();
/** In-flight fetches so parallel requests for the same voice share one download. */
const voiceInflight = new Map();

const HF_VOICE_URL = (fileName, modelId = MODEL_ID) =>
  `https://huggingface.co/${modelId}/resolve/main/voices/${fileName}`;

/** English voices shipped by `npm run download-model` (no need to HEAD all files). */
const LOCAL_ENGLISH_VOICES = [
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

function voiceResponse(buf) {
  return new Response(buf.slice(0), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "inline",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

async function readFromVoiceCache(fileName) {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open("kokoro-voices");
    const hit = await cache.match(HF_VOICE_URL(fileName));
    if (!hit || !hit.ok) return null;
    const len = Number(hit.headers.get("content-length") || 0);
    if (len > 0 && len < MIN_VOICE_BYTES) {
      await cache.delete(HF_VOICE_URL(fileName));
      return null;
    }
    const buf = await hit.arrayBuffer();
    if (buf.byteLength < MIN_VOICE_BYTES) {
      await cache.delete(HF_VOICE_URL(fileName));
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

async function writeToVoiceCache(fileName, buf) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open("kokoro-voices");
    await cache.put(HF_VOICE_URL(fileName), voiceResponse(buf));
  } catch {
    /* quota / private mode — ignore */
  }
}

/**
 * Load a voice once: memory → Cache API → user library only.
 * Never hits Hugging Face or site /models.
 */
async function fetchVoiceBuffer(fileName) {
  if (voiceMemory.has(fileName)) return voiceMemory.get(fileName);
  if (voiceInflight.has(fileName)) return voiceInflight.get(fileName);

  const job = (async () => {
    const cached = await readFromVoiceCache(fileName);
    if (cached) {
      voiceMemory.set(fileName, cached);
      return cached;
    }

    if (!modelLibraryRoot) {
      throw new Error(
        `Voice "${fileName.replace(/\.bin$/, "")}" needs a model library folder. Storage → Choose folder… then Download a model.`,
      );
    }

    for (const repo of [MODEL_ID, V1_MODEL_ID]) {
      const libBuf = await readFromModelLibrary(repo, `voices/${fileName}`);
      if (libBuf && libBuf.byteLength >= MIN_VOICE_BYTES) {
        voiceMemory.set(fileName, libBuf);
        await writeToVoiceCache(fileName, libBuf);
        return libBuf;
      }
    }

    throw new Error(
      `Voice "${fileName.replace(/\.bin$/, "")}" not in your library. Download the model pack (includes voices/).`,
    );
  })();

  voiceInflight.set(fileName, job);
  try {
    return await job;
  } finally {
    voiceInflight.delete(fileName);
  }
}

const HF_ANY_FILE_RE =
  /https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+?)(?:\?|$)/i;

self.fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input?.url;

  if (typeof url !== "string") {
    return originalFetch(input, init);
  }

  // Voice bins (kokoro hardcodes HF URLs) → local only
  const voiceMatch = url.match(HF_VOICE_RE);
  if (voiceMatch) {
    return fetchVoiceBuffer(voiceMatch[2]).then((buf) => voiceResponse(buf));
  }

  // HF model URLs → user library only (never network / never site repo)
  const hfFile = url.match(HF_ANY_FILE_RE);
  if (hfFile) {
    const modelId = hfFile[1];
    const fileRel = hfFile[2];
    return (async () => {
      if (!modelLibraryRoot) {
        return new Response(
          "No model library folder. Storage → Choose folder… then Download.",
          { status: 404, statusText: "Not Found (local only)" },
        );
      }
      const buf = await readFromModelLibrary(modelId, fileRel);
      if (buf && buf.byteLength > 0) {
        const ct = fileRel.endsWith(".json")
          ? "application/json"
          : "application/octet-stream";
        return libraryResponse(buf, ct);
      }
      return new Response(
        `Missing in library: ${modelId}/${fileRel}. Download this model pack first.`,
        { status: 404, statusText: "Not Found (local library)" },
      );
    })();
  }

  // Transformers localModelPath hits same-origin /models/... → serve only from library
  try {
    const u = new URL(url, self.location.origin);
    const m = u.pathname.match(/\/models\/(.+)$/);
    if (m) {
      const fullRel = decodeURIComponent(m[1]);
      return (async () => {
        if (!modelLibraryRoot) {
          return new Response(
            "No model library folder set. Storage → Choose folder…, Download a model, then load it.",
            { status: 404, statusText: "Not Found (local library)" },
          );
        }
        const buf = await readFromModelLibraryPath(fullRel);
        if (buf && buf.byteLength > 0) {
          const ct = fullRel.endsWith(".json")
            ? "application/json"
            : "application/octet-stream";
          return libraryResponse(buf, ct);
        }
        return new Response(
          `Missing in your library: models/${fullRel}. Use Download on this model.`,
          { status: 404, statusText: "Not Found (local library)" },
        );
      })();
    }
  } catch {
    /* ignore */
  }

  // Non-model requests (wasm CDN, etc.) still use network
  return originalFetch(input, init);
};

/**
 * Light cleanup: drop cache entries that look empty (by Content-Length only).
 * Does not re-download or read full bodies for every voice.
 */
async function purgeBadVoiceCache() {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open("kokoro-voices");
    const keys = await cache.keys();
    await Promise.all(
      keys.map(async (req) => {
        const res = await cache.match(req);
        if (!res || !res.ok || res.status === 204) {
          await cache.delete(req);
          return;
        }
        const len = Number(res.headers.get("content-length") || 0);
        if (len > 0 && len < MIN_VOICE_BYTES) await cache.delete(req);
      }),
    );
  } catch (e) {
    console.warn("Unable to purge voice cache:", e);
  }
}

/**
 * Prefer the English voices we self-host. One cheap HEAD on af_heart.bin
 * instead of probing every file (avoids a flood of requests on load).
 */
async function filterVoicesToLocal(voices) {
  if (!voices || typeof voices !== "object") return voices;

  let inLibrary = false;
  if (modelLibraryRoot) {
    const buf = await readFromModelLibrary(MODEL_ID, "voices/af_heart.bin");
    if (buf && buf.byteLength >= MIN_VOICE_BYTES) inLibrary = true;
    if (!inLibrary) {
      const buf2 = await readFromModelLibrary(V1_MODEL_ID, "voices/af_heart.bin");
      if (buf2 && buf2.byteLength >= MIN_VOICE_BYTES) inLibrary = true;
    }
  }

  if (!inLibrary) return voices;

  const local = {};
  for (const id of LOCAL_ENGLISH_VOICES) {
    if (voices[id]) local[id] = voices[id];
  }
  return Object.keys(local).length > 0 ? local : voices;
}

/**
 * Detect WebGPU support (adapter must be available).
 */
async function detectWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * Infer dtype from onnx filename for size checks.
 * @param {string} urlOrPath
 */
function dtypeFromOnnxPath(urlOrPath) {
  const s = String(urlOrPath);
  if (/model_q4f16/i.test(s)) return "q4f16";
  if (/model_q4/i.test(s)) return "q4";
  if (/model_fp16/i.test(s)) return "fp16";
  if (/model_quantized/i.test(s)) return "q8";
  if (/model\.onnx/i.test(s)) return "fp32";
  return "q8";
}

/** ONNX present only if readable from the user library with a sane size. */
async function existsOnnx(url) {
  if (!modelLibraryRoot) return false;
  try {
    const u = new URL(url, self.location.origin);
    const m = u.pathname.match(/\/models\/(.+)$/);
    if (!m) return false;
    const fullRel = decodeURIComponent(m[1]);
    const buf = await readFromModelLibraryPath(fullRel);
    return Boolean(
      buf && weightSizeOk(dtypeFromOnnxPath(fullRel), buf.byteLength),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve ONNX filename for a dtype (transformers.js / kokoro-js convention).
 * @param {string} dtype
 */
function onnxFileForDtype(dtype) {
  switch (dtype) {
    case "fp32":
      return "model.onnx";
    case "fp16":
      return "model_fp16.onnx";
    case "q4":
      return "model_q4.onnx";
    case "q4f16":
      return "model_q4f16.onnx";
    case "q8":
    default:
      return "model_quantized.onnx";
  }
}

/**
 * List onnx/*.onnx filenames inside a resolved pack (for errors / probing).
 * @param {string} modelId
 */
async function listPackOnnxFiles(modelId) {
  const pack = await resolvePackDir(modelId);
  if (!pack) return [];
  /** @type {string[]} */
  const names = [];
  try {
    const onnx = await pack.getDirectoryHandle("onnx");
    for await (const [name, h] of onnx.entries()) {
      if (h.kind === "file" && name.endsWith(".onnx")) {
        try {
          const f = await h.getFile();
          const mb = (f.size / (1024 * 1024)).toFixed(1);
          names.push(`${name} (${mb} MB)`);
        } catch {
          names.push(name);
        }
      }
    }
  } catch {
    /* no onnx dir */
  }
  return names;
}

/**
 * Pick device + dtype from the user library only (no site/repo packs).
 */
async function pickRuntime(preferWebGPU) {
  if (!modelLibraryRoot) {
    throw new Error(
      "All models are local-only. Storage → Choose folder…, Download a model, then select it to load.",
    );
  }

  const wanted = activeModel.dtype || "q8";
  const devicePref = activeModel.devicePref || "auto";

  const pickDevice = (dtype) => {
    if (devicePref === "wasm") return "wasm";
    if (devicePref === "webgpu") return preferWebGPU ? "webgpu" : "wasm";
    if (dtype === "fp32" || dtype === "fp16") {
      return devicePref === "webgpu" && preferWebGPU ? "webgpu" : "wasm";
    }
    return "wasm";
  };

  /**
   * Try to load a specific onnx file for a model id.
   * @param {string} id
   * @param {string} dtype
   * @param {string} file
   */
  async function tryFile(id, dtype, file) {
    const rel = `onnx/${file}`;
    const buf = await readFromModelLibrary(id, rel);
    if (!buf) return null;
    // Exact filename match → only require a real multi‑MB file (not SPA HTML)
    if (!weightSizeOk(dtype, buf.byteLength, { byName: true })) return null;
    return buf;
  }

  // Probe wanted dtype first, then other common files in the pack
  /** @type {[string, string][]} */
  const candidates = [
    [wanted, onnxFileForDtype(wanted)],
    ["q8", "model_quantized.onnx"],
    ["fp32", "model.onnx"],
    ["q4", "model_q4.onnx"],
  ];
  // de-dupe by file name
  const seenFiles = new Set();
  const ordered = [];
  for (const c of candidates) {
    if (seenFiles.has(c[1])) continue;
    seenFiles.add(c[1]);
    ordered.push(c);
  }

  for (const [dtype, file] of ordered) {
    // Prefer exact dtype first; only fall back to other files after
    if (dtype !== wanted && ordered[0][0] === wanted) {
      // still allow fallbacks after wanted exhausted — handled by loop order
    }
    for (const id of [MODEL_ID, V1_MODEL_ID]) {
      const buf = await tryFile(id, dtype, file);
      if (!buf) continue;
      // If this isn't the requested dtype, only accept as fallback after wanted failed
      // (loop already tries wanted first)
      if (id !== MODEL_ID) {
        MODEL_ID = id;
        MODEL_BASE = new URL(
          `models/${id}/`,
          self.location.origin + BASE_URL,
        ).pathname.replace(/\/?$/, "/");
      }
      return {
        device: pickDevice(dtype),
        dtype,
        source:
          dtype === wanted
            ? `library-${dtype}`
            : `library-${dtype}-fallback-from-${wanted}`,
      };
    }
  }

  const listed = await listPackOnnxFiles(MODEL_ID);
  const have =
    listed.length > 0
      ? ` Found in pack: ${listed.join(", ")}.`
      : " No onnx/*.onnx files found under your library for this pack.";
  const need = onnxFileForDtype(wanted);
  throw new Error(
    `No “${need}” for ${activeModel.shortLabel}.${have} Download “${activeModel.shortLabel}” (writes models/${MODEL_ID}/onnx/${need}), or load Balanced if you only have model_quantized.onnx.`,
  );
}

/**
 * Size gate for ONNX blobs.
 * When byName=true we already resolved the exact filename for that dtype,
 * so only enforce a minimum size (HF q4 exports can be surprisingly large).
 * @param {string} dtype
 * @param {number} bytes
 * @param {{ byName?: boolean }} [opts]
 */
function weightSizeOk(dtype, bytes, opts = {}) {
  if (!Number.isFinite(bytes) || bytes < 1_000_000) return false;
  const mb = bytes / (1024 * 1024);
  if (opts.byName) {
    // Filename is authoritative — accept any real multi‑MB weight file
    return mb >= 5 && mb <= 500;
  }
  switch (dtype) {
    case "fp32":
      return mb >= 180 && mb <= 450;
    case "fp16":
      return mb >= 80 && mb <= 280;
    case "q4":
    case "q4f16":
      // Community q4 can be ~50–300 MB depending on export
      return mb >= 15 && mb <= 400;
    case "q8":
    default:
      return mb >= 20 && mb <= 200;
  }
}

/** Split long text so each chunk stays within Kokoro's comfortable length. */
const SENTENCE_SPLIT = /(?<=[.!?…])\s+|\n+/;

/**
 * Coerce kokoro / transformers audio output to a *owned* Float32Array copy.
 * Always copy — ORT/transformers may reuse the underlying buffer on the next
 * generate() (esp. with large fp32 sessions), which garbles multi-chunk audio.
 * @param {unknown} audioOut
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
function extractAudio(audioOut) {
  const rate =
    Number(audioOut?.sampling_rate) ||
    Number(audioOut?.sample_rate) ||
    Number(audioOut?.sr) ||
    24000;

  let raw =
    audioOut?.audio ??
    audioOut?.data ??
    audioOut?.array ??
    audioOut;

  // Nested tensor-like: { data: TypedArray }
  if (raw && typeof raw === "object" && raw.data && !ArrayBuffer.isView(raw)) {
    raw = raw.data;
  }

  /** @type {Float32Array} */
  let samples;
  if (raw instanceof Float32Array) {
    samples = new Float32Array(raw); // defensive copy
  } else if (typeof Float16Array !== "undefined" && raw instanceof Float16Array) {
    samples = Float32Array.from(raw);
  } else if (raw instanceof Float64Array) {
    samples = Float32Array.from(raw);
  } else if (raw instanceof Int16Array) {
    samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) samples[i] = raw[i] / 32768;
  } else if (raw instanceof Int32Array) {
    samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) samples[i] = raw[i] / 2147483648;
  } else if (ArrayBuffer.isView(raw)) {
    // Unknown typed array — convert via number values, never reinterpret bits
    samples = Float32Array.from(raw);
  } else if (Array.isArray(raw)) {
    samples = Float32Array.from(raw, (v) => Number(v) || 0);
  } else {
    throw new Error("Model returned unexpected audio format.");
  }

  if (!samples.length) {
    throw new Error("Model returned empty audio.");
  }

  // Reject NaN/Inf (broken fp32 sessions often spit these)
  let nan = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) nan++;
    else {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  if (nan > samples.length * 0.01) {
    throw new Error(
      "Model produced invalid audio (NaN). Try Balanced (q8), or re-download High quality weights.",
    );
  }
  if (peak < 1e-7) {
    throw new Error("Model produced silent audio. Weights may be wrong for this dtype.");
  }

  return { samples, sampleRate: rate > 0 ? rate : 24000 };
}

/**
 * Peak-normalize to ~0.95 and soft-clip. Prevents harsh clipping/distortion
 * when models (esp. q4 / fp32) output peaks outside [-1, 1].
 * @param {Float32Array} samples
 */
function normalizeAudio(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (!Number.isFinite(peak) || peak < 1e-8) {
    return samples;
  }
  // Only scale down if clipping / very hot; gently lift very quiet audio
  let gain = 1;
  if (peak > 0.99) gain = 0.95 / peak;
  else if (peak < 0.08) gain = Math.min(0.9 / peak, 4);

  if (Math.abs(gain - 1) < 0.01) {
    // Still soft-clip any stragglers
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      samples[i] = x < -1 ? -1 : x > 1 ? 1 : x;
    }
    return samples;
  }

  for (let i = 0; i < samples.length; i++) {
    let x = samples[i] * gain;
    // soft clip
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    samples[i] = x;
  }
  return samples;
}

/**
 * Encode mono float samples as 16-bit PCM WAV (widely compatible).
 * IEEE float WAV (format 3) is often misread as garbage by players / editors.
 * @param {Float32Array} samples
 * @param {number} [sampleRate=24000]
 */
function floatToWavBlob(samples, sampleRate = 24000) {
  const pcm = normalizeAudio(
    samples instanceof Float32Array
      ? samples.slice()
      : Float32Array.from(samples),
  );
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < pcm.length; i++, o += 2) {
    // float [-1,1] → int16
    let s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Merge chunks with a short crossfade to avoid clicks between sentences.
 * @param {Float32Array[]} chunks
 * @param {number} sampleRate
 */
function mergeWithCrossfade(chunks, sampleRate) {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const fade = Math.min(
    Math.floor(sampleRate * 0.012), // ~12ms
    ...chunks.map((c) => Math.floor(c.length / 3)),
  );
  const safeFade = Math.max(0, fade);

  let total = chunks[0].length;
  for (let i = 1; i < chunks.length; i++) {
    total += chunks[i].length - safeFade;
  }
  const out = new Float32Array(total);
  out.set(chunks[0], 0);
  let offset = chunks[0].length;

  for (let i = 1; i < chunks.length; i++) {
    const cur = chunks[i];
    const start = offset - safeFade;
    for (let j = 0; j < safeFade; j++) {
      const t = j / safeFade;
      const a = out[start + j] * (1 - t);
      const b = cur[j] * t;
      out[start + j] = a + b;
    }
    out.set(cur.subarray(safeFade), offset);
    offset += cur.length - safeFade;
  }
  return out;
}

/**
 * Generate speech, splitting multi-sentence input for better accuracy.
 * Always encodes 16-bit PCM WAV so every model sounds clean in players.
 */
async function synthesizeToBlob(text, voice, speed) {
  const safeSpeed = Math.min(1.5, Math.max(0.5, Number(speed) || 1));
  const chunks = text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Prefer moderate chunk sizes — very long single passes hurt quality on q4/fp32
  /** @type {string[]} */
  const parts = [];
  for (const c of chunks.length > 0 ? chunks : [text]) {
    if (c.length <= 220) {
      parts.push(c);
    } else {
      // hard-split long sentences on commas / spaces
      let rest = c;
      while (rest.length > 220) {
        let cut = rest.lastIndexOf(",", 220);
        if (cut < 80) cut = rest.lastIndexOf(" ", 220);
        if (cut < 80) cut = 220;
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) parts.push(rest);
    }
  }
  if (parts.length === 0) parts.push(text);

  const sampleChunks = [];
  let sampleRate = 24000;
  for (let i = 0; i < parts.length; i++) {
    if (parts.length > 1) {
      self.postMessage({
        type: "status",
        message: `Generating speech… (${i + 1}/${parts.length})`,
      });
    }
    const raw = await tts.generate(parts[i], { voice, speed: safeSpeed });
    const { samples, sampleRate: sr } = extractAudio(raw);
    sampleChunks.push(samples);
    sampleRate = sr || sampleRate;
  }

  const merged = mergeWithCrossfade(sampleChunks, sampleRate);
  return floatToWavBlob(merged, sampleRate);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function isOnnxFile(file = "") {
  return /\.onnx$/i.test(file) || /onnx\//i.test(file);
}

/**
 * Map per-file callbacks into an overall load bar.
 * Intermediate files (config/tokenizer) used to jump to 100% and look "stuck"
 * while the multi‑MB ONNX weights were still loading with no new events.
 */
function onProgress(info) {
  if (!info || typeof info !== "object") return;

  const { status, file, progress, loaded, total } = info;
  const name = file || "";
  const onnx = isOnnxFile(name);

  if (status === "progress" && typeof progress === "number") {
    // Tokenizer/config: 5–35%. ONNX weights: 40–92%.
    const mapped = onnx
      ? 40 + Math.min(52, (progress / 100) * 52)
      : 5 + Math.min(30, (progress / 100) * 30);
    self.postMessage({
      type: "progress",
      progress: mapped,
      file: name,
      detail:
        total != null
          ? `${name || "file"} · ${formatBytes(loaded)} / ${formatBytes(total)}`
          : `${name || "file"} · ${Math.round(progress)}%`,
    });
    return;
  }

  if (status === "initiate" || status === "download") {
    self.postMessage({
      type: "progress",
      progress: onnx ? 40 : 8,
      file: name,
      detail: onnx
        ? `Loading weights ${name || ""} (large file — please wait)…`
        : name
          ? `Loading ${name}…`
          : "Loading model files…",
    });
    return;
  }

  if (status === "done") {
    self.postMessage({
      type: "progress",
      progress: onnx ? 92 : 35,
      file: name,
      detail: onnx
        ? `Loaded weights — starting engine…`
        : name
          ? `Loaded ${name}`
          : "Model files ready",
    });
  }
}

let tts = null;
let busy = false;
let loading = false;
/** @type {string | null} */
let pendingModelKey = null;
let loadGeneration = 0;

/**
 * Ensure tokenizer/config exist in the user library before from_pretrained.
 * Uses nested pack discovery so deep folders still work.
 */
async function assertModelFilesPresent() {
  if (!modelLibraryRoot) {
    throw new Error(
      `All models are local-only. Storage → Choose folder…, Download “${activeModel.shortLabel}”, then select it again.`,
    );
  }

  // Clear cache so a fresh Download is visible
  packDirCache.delete(MODEL_ID);

  const pack = await resolvePackDir(MODEL_ID);
  const needed = ["tokenizer.json", "config.json", "tokenizer_config.json"];
  const missing = [];
  const found = [];

  for (const f of needed) {
    let buf = null;
    if (pack) buf = await readFromPack(pack, f);
    if (!buf || buf.byteLength === 0) {
      buf = await readFromModelLibrary(MODEL_ID, f);
    }
    if (buf && buf.byteLength > 0) found.push(f);
    else missing.push(f);
  }

  if (missing.length === 0) return;

  const packs = await listAllPacks();
  const packHint =
    packs.length > 0
      ? ` Found pack folder(s): ${packs
          .slice(0, 5)
          .map((p) => p.path || p.name)
          .join(", ")}${packs.length > 5 ? "…" : ""}.`
      : " No model pack folders found under your library (need config/tokenizer + onnx/).";

  if (!pack) {
    throw new Error(
      `Could not locate pack “${MODEL_ID}” under your library.${packHint} Pick the parent folder that contains models/, or Download “${activeModel.shortLabel}”.`,
    );
  }

  throw new Error(
    `Pack found but incomplete for ${MODEL_ID}. Missing: ${missing.join(", ")}.${packHint} Use Download on “${activeModel.shortLabel}” to fill tokenizer/config.`,
  );
}

async function loadModel(device, dtype) {
  await assertModelFilesPresent();
  // Always pin wasm for speech quality unless webgpu was explicitly chosen.
  const dev = device === "webgpu" ? "webgpu" : "wasm";
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device: dev,
    progress_callback: onProgress,
  });
}

/**
 * @param {string} [modelKey]
 */
async function init(modelKey) {
  if (loading) {
    pendingModelKey = modelKey || DEFAULT_MODEL_KEY;
    self.postMessage({
      type: "status",
      message: "Queued model switch after current load…",
    });
    return;
  }

  loading = true;
  tts = null;
  const gen = ++loadGeneration;
  applyModelSelection(modelKey);
  configureOrtWasm();

  const heartbeat = setInterval(() => {
    if (gen !== loadGeneration) return;
    self.postMessage({
      type: "status",
      message: `Still loading ${activeModel.shortLabel}… (weights can take 30–90s on first run)`,
      modelKey: activeModelKey,
      modelLabel: activeModel.label,
    });
  }, 10000);

  try {
    // Drop any prior partial downloads that can stall subsequent loads
    try {
      if (typeof caches !== "undefined") {
        await caches.delete("transformers-cache");
      }
    } catch {
      /* ignore */
    }
    await purgeBadVoiceCache();

    const hasWebGPU = await detectWebGPU();
    let pick = await pickRuntime(hasWebGPU);
    let { device, dtype } = pick;

    const sourceLabel = pick.source.startsWith("library")
      ? `local library (${pick.dtype || pick.source})`
      : pick.source;

    self.postMessage({
      type: "status",
      message: `Loading ${activeModel.shortLabel} on ${device} (${dtype}) from ${sourceLabel}…`,
      device,
      dtype,
      modelKey: activeModelKey,
      modelLabel: activeModel.label,
    });
    self.postMessage({
      type: "progress",
      progress: 5,
      detail: "Reading config & tokenizer…",
    });

    try {
      tts = await loadModel(device, dtype);
    } catch (error) {
      // WebGPU/fp32 can fail on some GPUs — fall back to accurate wasm+q8
      if (device === "webgpu") {
        self.postMessage({
          type: "status",
          message: "WebGPU failed — falling back to WASM + q8…",
          device: "wasm",
          dtype: "q8",
        });
        device = "wasm";
        dtype = "q8";
        tts = await loadModel(device, dtype);
        pick = {
          ...pick,
          source: pick.source.startsWith("local") ? "local-q8" : pick.source,
        };
      } else {
        throw error;
      }
    }

    if (gen !== loadGeneration) return;

    self.postMessage({
      type: "progress",
      progress: 96,
      detail: "Preparing voices…",
    });
    self.postMessage({
      type: "status",
      message: "Model weights ready — preparing voices…",
    });

    const voices = await filterVoicesToLocal(tts.voices);
    if (gen !== loadGeneration) return;

    self.postMessage({
      type: "ready",
      voices,
      device,
      dtype,
      source: pick.source,
      modelKey: activeModelKey,
      modelId: MODEL_ID,
      modelLabel: activeModel.label,
      modelShortLabel: activeModel.shortLabel,
    });
  } catch (error) {
    if (gen !== loadGeneration) return;
    const raw = error?.message || String(error);
    const friendly = /local_files_only|allowRemoteModels|not found locally/i.test(
      raw,
    )
      ? `Files missing in your local library for ${MODEL_ID}. Storage → folder → Download “${activeModel.shortLabel}”, then load again. (No models from the website/repo.)`
      : raw;
    self.postMessage({
      type: "error",
      message: friendly,
      modelKey: activeModelKey,
    });
  } finally {
    clearInterval(heartbeat);
    if (gen === loadGeneration) {
      loading = false;
      if (pendingModelKey) {
        const next = pendingModelKey;
        pendingModelKey = null;
        // Avoid tight loop if same key failed repeatedly
        if (next !== activeModelKey || !tts) {
          await init(next);
        }
      }
    }
  }
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};

  if (data.type === "set-model-library") {
    modelLibraryRoot = data.handle || null;
    packDirCache.clear();
    return;
  }

  if (data.type === "load-model") {
    if (busy) {
      self.postMessage({
        type: "error",
        message: "Finish generating before switching models.",
      });
      return;
    }
    await init(data.modelKey);
    return;
  }

  if (data.type === "generate") {
    if (!tts) {
      self.postMessage({ type: "error", message: "Model is not ready yet." });
      return;
    }
    if (busy || loading) {
      self.postMessage({
        type: "error",
        message: loading ? "Model is still loading." : "Already generating speech.",
      });
      return;
    }

    const text = String(data.text || "").trim();
    const voice = data.voice || "af_heart";
    const speed = Number(data.speed) || 1;

    if (!text) {
      self.postMessage({ type: "error", message: "Please enter some text." });
      return;
    }

    busy = true;
    self.postMessage({ type: "status", message: "Generating speech…" });

    try {
      const blob = await synthesizeToBlob(text, voice, speed);
      const buffer = await blob.arrayBuffer();

      self.postMessage(
        {
          type: "complete",
          text,
          voice,
          speed,
          mimeType: blob.type || "audio/wav",
          buffer,
          modelKey: activeModelKey,
        },
        [buffer],
      );
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error?.message || String(error),
      });
    } finally {
      busy = false;
    }
  }
});

// Main thread chooses the model (saved preference or default).
self.postMessage({ type: "worker-ready", models: true });
