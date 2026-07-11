/**
 * User-chosen local model library (File System Access API).
 * Layout mirrors Hugging Face under the chosen folder:
 *   {library}/{modelId}/config.json
 *   {library}/{modelId}/onnx/model_quantized.onnx
 *   {library}/{modelId}/voices/*.bin
 */

import {
  filesForModelEntry,
  getModelEntry,
  onnxFileForDtype,
} from "./modelCatalog.js";

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
 * @param {import("./modelCatalog.js").ModelEntry} entry
 */
export async function isEntryInLibrary(root, entry) {
  const rel = `${entry.modelId}/onnx/${onnxFileForDtype(entry.dtype)}`;
  try {
    const fh = await resolveFileHandle(root, rel, { create: false });
    const file = await fh.getFile();
    return file.size >= 1_000_000;
  } catch {
    return false;
  }
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
 * Download catalog model files from Hugging Face.
 * Optionally writes into the user library folder and/or returns buffers
 * for GitHub upload.
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
    const dest = `${modelId}/${rel}`;

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
          /* ignore read failure for skip */
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
      ? `${entry.shortLabel} saved to your model library folder.`
      : `${entry.shortLabel} downloaded.`,
  });

  return collected;
}

/**
 * Download catalog model files from Hugging Face into the user library folder.
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
