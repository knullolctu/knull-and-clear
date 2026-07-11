/**
 * User-chosen local model library (File System Access API).
 *
 * Write path (always fixed):
 *   {libraryRoot}/models/{modelId}/config.json
 *   {libraryRoot}/models/{modelId}/onnx/…
 *   {libraryRoot}/models/{modelId}/voices/…
 *
 * Read path auto-scans nested folders so any of these work:
 *   {root}/models/{modelId}/…
 *   {root}/{modelId}/…
 *   {root}/…/models/{modelId}/…  (nested parents)
 *   pack folder found by name match deeper in the tree
 */

import {
  ENGLISH_VOICES,
  MODEL_CATALOG,
  filesForModelEntry,
  getModelEntry,
  onnxFileForDtype,
} from "./modelCatalog.js";

/** Preferred write prefix under the user-chosen folder. */
export const LIBRARY_MODELS_PREFIX = "models";

/** Max depth when scanning for nested packs. */
const MAX_SCAN_DEPTH = 8;

/**
 * Preferred write path under library root.
 * @param {string} modelId
 * @param {string} fileRel
 */
export function pathInLibrary(modelId, fileRel) {
  const file = String(fileRel || "").replace(/^\/+/, "");
  return `${LIBRARY_MODELS_PREFIX}/${modelId}/${file}`.replace(/\/+/g, "/");
}

/**
 * Candidate relative paths for reading a model file (canonical first).
 * @param {string} modelId
 * @param {string} fileRel
 */
export function readPathCandidates(modelId, fileRel) {
  const file = String(fileRel || "").replace(/^\/+/, "");
  const id = String(modelId || "").replace(/^\/+|\/+$/g, "");
  const short = id.split("/").filter(Boolean).pop() || id;
  /** @type {string[]} */
  const out = [
    `${LIBRARY_MODELS_PREFIX}/${id}/${file}`,
    `${id}/${file}`,
    // User selected the `models` folder itself
    `${id.split("/").slice(1).join("/")}/${file}`,
    // Pack dir only named by last segment
    `${LIBRARY_MODELS_PREFIX}/${short}/${file}`,
    `${short}/${file}`,
    file, // flat: root is the pack
  ];
  // De-dupe
  return [...new Set(out.map((p) => p.replace(/\/+/g, "/").replace(/^\/+/, "")))];
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath
 * @param {{ create?: boolean }} [opts]
 */
export async function resolveFileHandle(root, relativePath, opts = {}) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], {
      create: Boolean(opts.create),
    });
  }
  return dir.getFileHandle(parts[parts.length - 1], {
    create: Boolean(opts.create),
  });
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath
 */
export async function libraryFileExists(root, relativePath) {
  try {
    const fh = await resolveFileHandle(root, relativePath, { create: false });
    const file = await fh.getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath
 * @returns {Promise<number>}
 */
export async function libraryFileSize(root, relativePath) {
  try {
    const fh = await resolveFileHandle(root, relativePath, { create: false });
    const file = await fh.getFile();
    return file.size || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {FileSystemDirectoryHandle} dir
 */
export async function isModelPackDir(dir) {
  // Weights folder is enough to locate a pack (JSON sidecars checked separately)
  try {
    const onnx = await dir.getDirectoryHandle("onnx");
    for await (const [name, handle] of onnx.entries()) {
      if (handle.kind === "file" && name.endsWith(".onnx")) return true;
    }
  } catch {
    /* */
  }
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".onnx")) return true;
    }
  } catch {
    /* */
  }
  return false;
}

/**
 * Walk nested directories; collect packs as { path, handle }.
 * path is relative to root ("" if root itself is a pack).
 * @param {FileSystemDirectoryHandle} root
 * @param {number} [maxDepth]
 */
export async function findNestedModelPacks(root, maxDepth = MAX_SCAN_DEPTH) {
  /** @type {{ path: string, handle: FileSystemDirectoryHandle, name: string }[]} */
  const found = [];

  /**
   * @param {FileSystemDirectoryHandle} dir
   * @param {string} rel
   * @param {number} depth
   */
  async function walk(dir, rel, depth) {
    if (depth > maxDepth) return;

    if (await isModelPackDir(dir)) {
      const name = rel ? rel.split("/").pop() || rel : dir.name;
      found.push({ path: rel, handle: dir, name });
      // Still scan children? Usually packs aren't nested in packs — stop.
      return;
    }

    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "directory") continue;
        // Skip junk
        if (
          name === "node_modules" ||
          name === ".git" ||
          name === "dist" ||
          name.startsWith(".")
        ) {
          continue;
        }
        const childRel = rel ? `${rel}/${name}` : name;
        await walk(handle, childRel, depth + 1);
      }
    } catch {
      /* ignore */
    }
  }

  await walk(root, "", 0);
  return found;
}

/**
 * Resolve directory handle for a catalog modelId by scanning nested folders.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} modelId
 * @returns {Promise<FileSystemDirectoryHandle | null>}
 */
export async function resolveModelPackDir(root, modelId) {
  const id = String(modelId || "").replace(/^\/+|\/+$/g, "");
  const segments = id.split("/").filter(Boolean);
  const short = segments[segments.length - 1] || id;
  const org = segments.length >= 2 ? segments[0] : "";
  const rootIsOrg =
    org &&
    (root.name === org || root.name.toLowerCase() === org.toLowerCase());

  // Root itself is the pack
  if (await isModelPackDir(root)) return root;

  // Fast path: fixed write locations + org-as-root
  const directPaths = [
    rootIsOrg ? short : null,
    `${LIBRARY_MODELS_PREFIX}/${id}`,
    id,
    short,
    `${LIBRARY_MODELS_PREFIX}/${short}`,
    org ? `${org}/${short}` : null,
    `${LIBRARY_MODELS_PREFIX}/${org}/${short}`,
  ].filter(Boolean);
  for (const rel of directPaths) {
    try {
      const parts = rel.split("/").filter(Boolean);
      let dir = root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      if (await isModelPackDir(dir)) return dir;
    } catch {
      /* try next */
    }
  }

  const packs = await findNestedModelPacks(root);
  if (packs.length === 0) return null;
  if (packs.length === 1) return packs[0].handle;

  let best = null;
  let bestScore = 0;
  for (const p of packs) {
    const path = (p.path || "").replace(/\\/g, "/");
    const name = p.name || "";
    let score = 0;
    if (path === id || path === `models/${id}`) score += 100;
    if (path.endsWith(`/${id}`) || path.endsWith(id)) score += 80;
    if (path.includes(id)) score += 50;
    if (name === short || name.toLowerCase() === short.toLowerCase()) score += 40;
    if (rootIsOrg && name.toLowerCase() === short.toLowerCase()) score += 60;
    if (path.toLowerCase().includes(short.toLowerCase())) score += 25;
    if (segments[0] && path.includes(segments[0])) score += 10;
    if (/kokoro/i.test(name) && /kokoro/i.test(short)) score += 15;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 15 && best ? best.handle : null;
}

/**
 * Read a file for modelId, auto-reading nested pack locations.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} modelId
 * @param {string} fileRel
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function readLibraryModelFile(root, modelId, fileRel) {
  const file = String(fileRel || "").replace(/^\/+/, "");

  // Try known relative paths first
  for (const rel of readPathCandidates(modelId, file)) {
    try {
      const fh = await resolveFileHandle(root, rel, { create: false });
      const f = await fh.getFile();
      if (f.size > 0) return await f.arrayBuffer();
    } catch {
      /* next */
    }
  }

  // Nested pack resolution
  const pack = await resolveModelPackDir(root, modelId);
  if (!pack) return null;
  try {
    const parts = file.split("/").filter(Boolean);
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
 * List model ids found anywhere under root (nested).
 * @param {FileSystemDirectoryHandle} root
 */
export async function listLibraryModelIds(root) {
  /** @type {string[]} */
  const modelIds = [];
  const packs = await findNestedModelPacks(root);

  // Map packs to catalog modelIds when possible
  for (const entry of MODEL_CATALOG) {
    const pack = await resolveModelPackDir(root, entry.modelId);
    if (pack && !modelIds.includes(entry.modelId)) modelIds.push(entry.modelId);
  }

  for (const p of packs) {
    // Prefer full path if it looks like org/name
    let id = p.path || p.name;
    // Strip leading "models/"
    if (id.startsWith(`${LIBRARY_MODELS_PREFIX}/`)) {
      id = id.slice(LIBRARY_MODELS_PREFIX.length + 1);
    }
    if (id && !modelIds.includes(id)) {
      // Only add if not already covered by a catalog id that ends the same
      const covered = modelIds.some(
        (m) => m === id || m.endsWith(`/${p.name}`) || m.endsWith(p.name),
      );
      if (!covered) modelIds.push(id);
    }
  }

  return modelIds;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {import("./modelCatalog.js").ModelEntry} entry
 */
export async function isEntryInLibrary(root, entry) {
  const onnx = onnxFileForDtype(entry.dtype);
  // Ready only if weights AND tokenizer/config exist (can actually load)
  const exact = await readLibraryModelFile(
    root,
    entry.modelId,
    `onnx/${onnx}`,
  );
  if (!exact || exact.byteLength < 5_000_000) return false;
  const tok = await readLibraryModelFile(root, entry.modelId, "tokenizer.json");
  const cfg = await readLibraryModelFile(root, entry.modelId, "config.json");
  return Boolean(tok && tok.byteLength > 0 && cfg && cfg.byteLength > 0);
}

/**
 * Scan library for catalog models (nested-aware).
 * @param {FileSystemDirectoryHandle} root
 */
export async function scanLibraryCatalog(root) {
  const packs = await findNestedModelPacks(root);
  const modelIds = await listLibraryModelIds(root);
  /** @type {{ key: string, shortLabel: string, present: boolean, onnx?: string }[]} */
  const models = [];
  for (const entry of MODEL_CATALOG) {
    const present = await isEntryInLibrary(root, entry);
    models.push({
      key: entry.key,
      shortLabel: entry.shortLabel,
      present,
      onnx: present ? onnxFileForDtype(entry.dtype) : undefined,
    });
  }

  let voiceSampleCount = 0;
  for (const entry of MODEL_CATALOG) {
    if (!(await isEntryInLibrary(root, entry))) continue;
    for (const v of ENGLISH_VOICES.slice(0, 6)) {
      const buf = await readLibraryModelFile(
        root,
        entry.modelId,
        `voices/${v}.bin`,
      );
      if (buf && buf.byteLength > 0) voiceSampleCount++;
    }
    break;
  }

  return {
    layout: "models+nested",
    modelIds,
    packPaths: packs.map((p) => p.path || "(root pack)"),
    models,
    presentCount: models.filter((m) => m.present).length,
    voiceSampleCount,
  };
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relativePath
 * @param {ArrayBuffer|Uint8Array|Blob} data
 */
export async function writeLibraryFile(root, relativePath, data) {
  const fh = await resolveFileHandle(root, relativePath, { create: true });
  const writable = await fh.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * Download English voice .bin packs into {root}/models/{modelId}/voices/.
 * @param {object} opts
 * @param {FileSystemDirectoryHandle} opts.libraryRoot
 * @param {string} [opts.modelId]
 * @param {string[]} [opts.voiceIds] defaults to ENGLISH_VOICES
 * @param {(ev: object) => void} [opts.onProgress]
 */
export async function downloadVoicesToLibrary({
  libraryRoot,
  modelId = "onnx-community/Kokoro-82M-v1.0-ONNX",
  voiceIds = ENGLISH_VOICES,
  onProgress,
}) {
  if (!libraryRoot) {
    throw new Error("Choose a model library folder first.");
  }
  const id = String(modelId || "").replace(/^\/+|\/+$/g, "");
  const voices = voiceIds?.length ? voiceIds : ENGLISH_VOICES;
  let saved = 0;
  let skipped = 0;

  onProgress?.({
    type: "start",
    message: `Downloading ${voices.length} voices for ${id}…`,
  });

  for (let i = 0; i < voices.length; i++) {
    const voice = voices[i];
    const rel = `voices/${voice}.bin`;
    const dest = pathInLibrary(id, rel);

    // Skip if already present (nested-aware read)
    const existing = await readLibraryModelFile(libraryRoot, id, rel);
    if (existing && existing.byteLength > 1000) {
      skipped++;
      onProgress?.({
        type: "skip",
        file: rel,
        index: i + 1,
        count: voices.length,
        message: `Skip ${voice} (already present)`,
      });
      continue;
    }

    const url = `https://huggingface.co/${id}/resolve/main/${rel}`;
    onProgress?.({
      type: "start",
      file: rel,
      index: i + 1,
      count: voices.length,
      message: `Downloading voice ${voice}… (${i + 1}/${voices.length})`,
    });

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed voice ${voice}: HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) {
      throw new Error(`Voice ${voice} file too small (${buf.byteLength} B)`);
    }
    await writeLibraryFile(libraryRoot, dest, buf);
    saved++;
    onProgress?.({
      type: "file-done",
      file: rel,
      index: i + 1,
      count: voices.length,
      loaded: buf.byteLength,
      total: buf.byteLength,
      message: `Saved ${voice}`,
    });
  }

  onProgress?.({
    type: "complete",
    message: `Voices ready: ${saved} downloaded, ${skipped} already present.`,
    saved,
    skipped,
  });

  return { saved, skipped, modelId: id };
}

/**
 * Download into fixed {root}/models/{modelId}/… (creates nested folders).
 *
 * @param {object} opts
 * @param {string} opts.modelKey
 * @param {FileSystemDirectoryHandle} [opts.libraryRoot]
 * @param {boolean} [opts.returnBuffers=false]
 * @param {(ev: object) => void} [opts.onProgress]
 */
export async function downloadEntryFiles({
  modelKey,
  libraryRoot = null,
  returnBuffers = false,
  onProgress,
}) {
  const entry = getModelEntry(modelKey);
  const files = filesForModelEntry(entry);
  const modelId = entry.modelId;
  /** @type {{ path: string, data: ArrayBuffer }[]} */
  const collected = [];

  onProgress?.({
    type: "start",
    message: `Downloading ${entry.shortLabel} (${files.length} files)…`,
  });

  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const dest = libraryRoot
      ? pathInLibrary(modelId, rel)
      : `${LIBRARY_MODELS_PREFIX}/${modelId}/${rel}`;

    // Skip if already present at write path OR any nested read location
    if (libraryRoot) {
      const existing = await readLibraryModelFile(libraryRoot, modelId, rel);
      if (existing && existing.byteLength > 0) {
        onProgress?.({
          type: "skip",
          file: rel,
          message: `Skip ${rel} (already present)`,
          index: i + 1,
          count: files.length,
        });
        if (returnBuffers) collected.push({ path: rel, data: existing });
        continue;
      }
    }

    const url = `https://huggingface.co/${modelId}/resolve/main/${rel}`;
    onProgress?.({
      type: "start",
      file: rel,
      message: `Downloading ${rel}…`,
      index: i + 1,
      count: files.length,
    });

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed ${rel}: HTTP ${res.status}`);
    }

    const total = Number(res.headers.get("content-length")) || 0;
    let buf;

    if (res.body && total > 2_000_000) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      let lastEmit = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - lastEmit > total * 0.03) {
          lastEmit = loaded;
          onProgress?.({
            type: "progress",
            file: rel,
            loaded,
            total,
            message: `${rel}: ${formatBytes(loaded)} / ${formatBytes(total)}`,
          });
        }
      }
      buf = concatChunks(chunks);
    } else {
      buf = await res.arrayBuffer();
    }

    if (libraryRoot) {
      await writeLibraryFile(libraryRoot, dest, buf);
    }
    if (returnBuffers) {
      collected.push({ path: rel, data: buf });
    }

    onProgress?.({
      type: "file-done",
      file: rel,
      loaded: buf.byteLength,
      total: buf.byteLength,
      message: libraryRoot ? `Saved ${rel}` : `Fetched ${rel}`,
    });
  }

  onProgress?.({
    type: "complete",
    message: libraryRoot
      ? `${entry.shortLabel} saved under models/${modelId}/`
      : `${entry.shortLabel} downloaded.`,
  });

  return collected;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} modelKey
 * @param {(ev: object) => void} [onProgress]
 */
export async function downloadEntryToLibrary(root, modelKey, onProgress) {
  await downloadEntryFiles({
    modelKey,
    libraryRoot: root,
    returnBuffers: false,
    onProgress,
  });
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
