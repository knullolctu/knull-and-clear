/**
 * User-chosen local model library (File System Access API).
 *
 * Fixed structure (same idea as site /models/):
 *   {libraryRoot}/models/{modelId}/config.json
 *   {libraryRoot}/models/{modelId}/onnx/model_quantized.onnx
 *   {libraryRoot}/models/{modelId}/voices/*.bin
 */

import {
  ENGLISH_VOICES,
  MODEL_CATALOG,
  filesForModelEntry,
  getModelEntry,
  onnxFileForDtype,
} from "./modelCatalog.js";

/** Prefix under the user-chosen folder — always "models". */
export const LIBRARY_MODELS_PREFIX = "models";

/**
 * Path under library root for a file in a model pack.
 * @param {string} modelId e.g. onnx-community/Kokoro-82M-v1.0-ONNX
 * @param {string} fileRel e.g. onnx/model_quantized.onnx
 */
export function pathInLibrary(modelId, fileRel) {
  const file = String(fileRel || "").replace(/^\/+/, "");
  return `${LIBRARY_MODELS_PREFIX}/${modelId}/${file}`.replace(/\/+/g, "/");
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
async function isModelPackDir(dir) {
  try {
    await dir.getFileHandle("config.json");
  } catch {
    return false;
  }
  try {
    const onnx = await dir.getDirectoryHandle("onnx");
    for await (const [name, handle] of onnx.entries()) {
      if (handle.kind === "file" && name.endsWith(".onnx")) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * List model ids found under {root}/models/...
 * @param {FileSystemDirectoryHandle} root
 */
export async function listLibraryModelIds(root) {
  /** @type {string[]} */
  const modelIds = [];
  let modelsDir;
  try {
    modelsDir = await root.getDirectoryHandle(LIBRARY_MODELS_PREFIX);
  } catch {
    return modelIds;
  }

  // Known catalog packs first
  for (const entry of MODEL_CATALOG) {
    const rel = pathInLibrary(entry.modelId, "config.json");
    if (await libraryFileExists(root, rel)) {
      if (!modelIds.includes(entry.modelId)) modelIds.push(entry.modelId);
    }
  }

  // Generic scan: models/{org}/{name}/
  try {
    for await (const [orgName, orgHandle] of modelsDir.entries()) {
      if (orgHandle.kind !== "directory") continue;
      if (await isModelPackDir(orgHandle)) {
        if (!modelIds.includes(orgName)) modelIds.push(orgName);
        continue;
      }
      try {
        for await (const [packName, packHandle] of orgHandle.entries()) {
          if (packHandle.kind !== "directory") continue;
          if (await isModelPackDir(packHandle)) {
            const id = `${orgName}/${packName}`;
            if (!modelIds.includes(id)) modelIds.push(id);
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return modelIds;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {import("./modelCatalog.js").ModelEntry} entry
 */
export async function isEntryInLibrary(root, entry) {
  const onnx = onnxFileForDtype(entry.dtype);
  const candidates = [
    pathInLibrary(entry.modelId, `onnx/${onnx}`),
    pathInLibrary(entry.modelId, "onnx/model_quantized.onnx"),
  ];
  for (const rel of candidates) {
    const size = await libraryFileSize(root, rel);
    if (size >= 1_000_000) return true;
  }
  return false;
}

/**
 * Scan library for catalog models under fixed /models structure.
 * @param {FileSystemDirectoryHandle} root
 */
export async function scanLibraryCatalog(root) {
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
  const probeIds = modelIds.length
    ? modelIds
    : MODEL_CATALOG.map((m) => m.modelId);
  for (const id of probeIds) {
    for (const v of ENGLISH_VOICES.slice(0, 8)) {
      if (await libraryFileExists(root, pathInLibrary(id, `voices/${v}.bin`))) {
        voiceSampleCount++;
      }
    }
    if (voiceSampleCount) break;
  }

  return {
    layout: "models",
    modelIds,
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
 * Download catalog model files into {root}/models/{modelId}/…
 * (Install only — runtime stays offline.)
 *
 * @param {object} opts
 * @param {string} opts.modelKey
 * @param {FileSystemDirectoryHandle} [opts.libraryRoot]
 * @param {boolean} [opts.returnBuffers=false]
 * @param {(ev: object) => void} [opts.onProgress]
 * @returns {Promise<{ path: string, data: ArrayBuffer }[]>}
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

    if (libraryRoot && (await libraryFileExists(libraryRoot, dest))) {
      onProgress?.({
        type: "skip",
        file: rel,
        message: `Skip ${rel} (already present)`,
        index: i + 1,
        count: files.length,
      });
      if (returnBuffers) {
        try {
          const fh = await resolveFileHandle(libraryRoot, dest, {
            create: false,
          });
          const file = await fh.getFile();
          collected.push({ path: rel, data: await file.arrayBuffer() });
        } catch {
          /* ignore */
        }
      }
      continue;
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
