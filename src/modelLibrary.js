/**
 * User-chosen local model library (File System Access API).
 *
 * Supported layouts (auto-detected or forced):
 *   nested        {root}/{modelId}/config.json + onnx/ + voices/
 *   flat          {root}/config.json + onnx/ + voices/   (folder is one model pack)
 *   public-models {root}/onnx-community/.../  (root = public/models or similar)
 */

import {
  ENGLISH_VOICES,
  MODEL_CATALOG,
  filesForModelEntry,
  getModelEntry,
  onnxFileForDtype,
} from "./modelCatalog.js";

/** @typedef {"auto"|"nested"|"flat"|"public-models"} LibraryLayout */

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
 * True if this directory looks like a Kokoro model pack root (has onnx + config).
 * @param {FileSystemDirectoryHandle} dir
 */
export async function isModelPackDir(dir) {
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
 * Detect how the chosen folder is organized.
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<{ layout: Exclude<LibraryLayout,"auto">, modelIds: string[], notes: string[] }>}
 */
export async function detectLibraryLayout(root) {
  const notes = [];
  const modelIds = [];

  // Flat: this folder IS a model pack
  if (await isModelPackDir(root)) {
    notes.push("Detected flat pack (config.json + onnx/ in the folder you chose).");
    return { layout: "flat", modelIds: ["(flat root)"], notes };
  }

  // public-models style: root has org folders (onnx-community/...)
  try {
    const org = await root.getDirectoryHandle("onnx-community");
    for await (const [name, handle] of org.entries()) {
      if (handle.kind !== "directory") continue;
      if (await isModelPackDir(handle)) {
        modelIds.push(`onnx-community/${name}`);
      }
    }
    if (modelIds.length) {
      notes.push(`Detected public/models layout (${modelIds.length} pack(s)).`);
      return { layout: "public-models", modelIds, notes };
    }
  } catch {
    /* not public-models */
  }

  // Nested: root/{modelId parts}/pack
  // Walk one or two levels for known catalog ids, and any org/name pair with onnx
  for (const entry of MODEL_CATALOG) {
    const rel = `${entry.modelId}/config.json`;
    if (await libraryFileExists(root, rel)) {
      if (!modelIds.includes(entry.modelId)) modelIds.push(entry.modelId);
    }
  }

  // Generic scan: top-level dirs
  try {
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "directory") continue;
      if (await isModelPackDir(handle)) {
        if (!modelIds.includes(name)) modelIds.push(name);
        continue;
      }
      // org/repo
      try {
        for await (const [sub, subh] of handle.entries()) {
          if (subh.kind !== "directory") continue;
          if (await isModelPackDir(subh)) {
            const id = `${name}/${sub}`;
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

  if (modelIds.length) {
    notes.push(`Detected nested library (${modelIds.length} pack(s)).`);
    return { layout: "nested", modelIds, notes };
  }

  notes.push(
    "No model pack found yet. Use Download, or point at a folder that contains onnx/ + config.json.",
  );
  return { layout: "nested", modelIds: [], notes };
}

/**
 * Map a logical model-relative path (config.json, onnx/…, voices/…) to a path under root.
 * @param {string} modelId
 * @param {string} fileRel e.g. onnx/model_quantized.onnx
 * @param {Exclude<LibraryLayout,"auto">} layout
 */
export function pathInLibrary(modelId, fileRel, layout) {
  const file = fileRel.replace(/^\/+/, "");
  if (layout === "flat") return file;
  if (layout === "public-models" || layout === "nested") {
    return `${modelId}/${file}`;
  }
  return `${modelId}/${file}`;
}

/**
 * Resolve effective layout (auto → detect).
 * @param {FileSystemDirectoryHandle} root
 * @param {LibraryLayout} preferred
 */
export async function resolveLibraryLayout(root, preferred = "auto") {
  if (preferred && preferred !== "auto") {
    return preferred;
  }
  const det = await detectLibraryLayout(root);
  return det.layout;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {import("./modelCatalog.js").ModelEntry} entry
 * @param {LibraryLayout} [layoutPref="auto"]
 */
export async function isEntryInLibrary(root, entry, layoutPref = "auto") {
  const layout = await resolveLibraryLayout(root, layoutPref);
  const onnx = onnxFileForDtype(entry.dtype);
  const candidates = [];

  if (layout === "flat") {
    candidates.push(pathInLibrary(entry.modelId, `onnx/${onnx}`, "flat"));
    if (entry.dtype !== "q8") {
      candidates.push(pathInLibrary(entry.modelId, "onnx/model_quantized.onnx", "flat"));
    }
  } else {
    candidates.push(pathInLibrary(entry.modelId, `onnx/${onnx}`, layout));
    if (entry.dtype !== "q8") {
      candidates.push(
        pathInLibrary(entry.modelId, "onnx/model_quantized.onnx", layout),
      );
    }
    // Also try flat in case auto was wrong
    candidates.push(`onnx/${onnx}`);
  }

  for (const rel of candidates) {
    const size = await libraryFileSize(root, rel);
    if (size >= 1_000_000) return true;
  }
  return false;
}

/**
 * List which catalog keys appear present in the library.
 * @param {FileSystemDirectoryHandle} root
 * @param {LibraryLayout} [layoutPref="auto"]
 */
export async function scanLibraryCatalog(root, layoutPref = "auto") {
  const layout = await resolveLibraryLayout(root, layoutPref);
  const det = await detectLibraryLayout(root);
  /** @type {{ key: string, shortLabel: string, present: boolean, onnx?: string }[]} */
  const models = [];
  for (const entry of MODEL_CATALOG) {
    const present = await isEntryInLibrary(root, entry, layout);
    models.push({
      key: entry.key,
      shortLabel: entry.shortLabel,
      present,
      onnx: present ? onnxFileForDtype(entry.dtype) : undefined,
    });
  }

  // Count voices if any pack exists
  let voiceCount = 0;
  const voiceProbeIds =
    layout === "flat"
      ? [""]
      : det.modelIds.filter((id) => id !== "(flat root)");
  const ids =
    layout === "flat"
      ? ["__flat__"]
      : voiceProbeIds.length
        ? voiceProbeIds
        : MODEL_CATALOG.map((m) => m.modelId);

  for (const id of ids) {
    for (const v of ENGLISH_VOICES.slice(0, 8)) {
      const rel =
        layout === "flat" || id === "__flat__"
          ? `voices/${v}.bin`
          : `${id}/voices/${v}.bin`;
      if (await libraryFileExists(root, rel)) voiceCount++;
    }
    if (voiceCount) break;
  }

  return {
    layout,
    detected: det,
    models,
    presentCount: models.filter((m) => m.present).length,
    voiceSampleCount: voiceCount,
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
 * Download catalog model files from Hugging Face into the local library only.
 * (Offline runtime never loads from the network — this is install-only.)
 *
 * @param {object} opts
 * @param {string} opts.modelKey
 * @param {FileSystemDirectoryHandle} [opts.libraryRoot]
 * @param {LibraryLayout} [opts.layout="auto"]
 * @param {boolean} [opts.returnBuffers=false]
 * @param {(ev: object) => void} [opts.onProgress]
 * @returns {Promise<{ path: string, data: ArrayBuffer }[]>}
 */
export async function downloadEntryFiles({
  modelKey,
  libraryRoot = null,
  layout = "auto",
  returnBuffers = false,
  onProgress,
}) {
  const entry = getModelEntry(modelKey);
  const files = filesForModelEntry(entry);
  const modelId = entry.modelId;
  /** @type {{ path: string, data: ArrayBuffer }[]} */
  const collected = [];

  let resolvedLayout = "nested";
  if (libraryRoot) {
    resolvedLayout = await resolveLibraryLayout(libraryRoot, layout);
  }

  onProgress?.({
    type: "start",
    message: `Downloading ${entry.shortLabel} (${files.length} files)…`,
  });

  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const dest = libraryRoot
      ? pathInLibrary(modelId, rel, resolvedLayout)
      : `${modelId}/${rel}`;

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
      ? `${entry.shortLabel} saved to your model library folder.`
      : `${entry.shortLabel} downloaded.`,
  });

  return collected;
}

/**
 * @param {FileSystemDirectoryHandle} root
 * @param {string} modelKey
 * @param {(ev: object) => void} [onProgress]
 * @param {LibraryLayout} [layout="auto"]
 */
export async function downloadEntryToLibrary(
  root,
  modelKey,
  onProgress,
  layout = "auto",
) {
  await downloadEntryFiles({
    modelKey,
    libraryRoot: root,
    layout,
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
