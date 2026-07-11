/**
 * Knull & Clear — main UI thread (by knull)
 * Model inference runs in a dedicated Web Worker (src/worker.js).
 */

import {
  DEFAULT_MODEL_KEY,
  getModelEntry,
  listModelsForUi,
} from "./modelCatalog.js";
import {
  downloadEntryFiles,
  isEntryInLibrary,
  scanLibraryCatalog,
} from "./modelLibrary.js";

const STORAGE_KEYS = {
  filenamePrefix: "knullclear.filenamePrefix",
  autoSave: "knullclear.autoSave",
  modelKey: "knullclear.modelKey",
};

const IDB_NAME = "knull-and-clear";
const IDB_STORE = "handles";
const IDB_DIR_KEY = "saveDirectory";
const IDB_MODEL_LIB_KEY = "modelLibraryDirectory";

const els = {
  overlay: document.getElementById("loading-overlay"),
  loadingMessage: document.getElementById("loading-message"),
  progressBar: document.getElementById("progress-bar"),
  progressDetail: document.getElementById("progress-detail"),
  deviceBadge: document.getElementById("device-badge"),
  textInput: document.getElementById("text-input"),
  charCount: document.getElementById("char-count"),
  voiceSelect: document.getElementById("voice-select"),
  voicePicker: document.getElementById("voice-picker"),
  voiceTrigger: document.getElementById("voice-trigger"),
  voiceTriggerText: document.getElementById("voice-trigger-text"),
  voiceMenu: document.getElementById("voice-menu"),
  modelSelect: document.getElementById("model-select"),
  modelPicker: document.getElementById("model-picker"),
  modelTrigger: document.getElementById("model-trigger"),
  modelTriggerText: document.getElementById("model-trigger-text"),
  modelMenu: document.getElementById("model-menu"),
  modelHint: document.getElementById("model-hint"),
  modelDownloadRow: document.getElementById("model-download-row"),
  modelDownloadInline: document.getElementById("model-download-inline"),
  modelDownloadProgress: document.getElementById("model-download-progress"),
  speedRange: document.getElementById("speed-range"),
  speedValue: document.getElementById("speed-value"),
  generateBtn: document.getElementById("generate-btn"),
  generateLabel: document.getElementById("generate-label"),
  downloadBtn: document.getElementById("download-btn"),
  clearBtn: document.getElementById("clear-btn"),
  statusBar: document.getElementById("status-bar"),
  resultsList: document.getElementById("results-list"),
  clearHistoryBtn: document.getElementById("clear-history-btn"),
  folderLabel: document.getElementById("folder-label"),
  pickFolderBtn: document.getElementById("pick-folder-btn"),
  clearFolderBtn: document.getElementById("clear-folder-btn"),
  folderHint: document.getElementById("folder-hint"),
  modelLibLabel: document.getElementById("model-lib-label"),
  pickModelLibBtn: document.getElementById("pick-model-lib-btn"),
  rescanModelLibBtn: document.getElementById("rescan-model-lib-btn"),
  clearModelLibBtn: document.getElementById("clear-model-lib-btn"),
  modelLibHint: document.getElementById("model-lib-hint"),
  modelLibScan: document.getElementById("model-lib-scan"),
  setupModal: document.getElementById("setup-modal"),
  setupChooseFolderBtn: document.getElementById("setup-choose-folder-btn"),
  setupOpenStorageBtn: document.getElementById("setup-open-storage-btn"),
  setupModalError: document.getElementById("setup-modal-error"),
  filenamePrefix: document.getElementById("filename-prefix"),
  autoSave: document.getElementById("auto-save"),
};

/** @type {Worker | null} */
let worker = null;
/**
 * @typedef {{
 *   id: string,
 *   url: string,
 *   blob: Blob,
 *   text: string,
 *   voice: string,
 *   speed: number,
 *   createdAt: number,
 * }} HistoryItem
 */
/** @type {HistoryItem[]} */
let history = [];
/** @type {HistoryItem | null} */
let latest = null;
let ready = false;
let generating = false;
/** @type {FileSystemDirectoryHandle | null} */
let saveDirHandle = null;
/** @type {FileSystemDirectoryHandle | null} */
let modelLibDirHandle = null;
/** @type {string} */
let selectedVoice = "af_heart";
/** @type {{ value: string, label: string, group: string }[]} */
let voiceOptions = [];
let voiceMenuOpen = false;
let voiceActiveIndex = -1;

/** @type {string} */
let selectedModelKey = DEFAULT_MODEL_KEY;
let modelMenuOpen = false;
let modelActiveIndex = -1;
const modelOptions = listModelsForUi();
let modelSwitchPending = false;
/** Model key to load when the next worker signals ready */
let pendingWorkerModelKey = null;

const supportsDirPicker =
  typeof window.showDirectoryPicker === "function" &&
  typeof indexedDB !== "undefined";

function setStatus(message, kind = "") {
  els.statusBar.textContent = message;
  els.statusBar.classList.remove("is-error", "is-success");
  if (kind === "error") els.statusBar.classList.add("is-error");
  if (kind === "success") els.statusBar.classList.add("is-success");
}

function updateCharCount() {
  els.charCount.textContent = String(els.textInput.value.length);
}

function updateSpeedLabel() {
  const value = Number(els.speedRange.value);
  els.speedValue.textContent = `${value.toFixed(2)}×`;
}

function setGenerating(isGenerating) {
  generating = isGenerating;
  els.generateBtn.disabled = !ready || isGenerating || !els.textInput.value.trim();
  els.generateBtn.classList.toggle("is-busy", isGenerating);
  els.generateLabel.textContent = isGenerating ? "Generating…" : "Generate speech";
  els.voiceTrigger.disabled = !ready || isGenerating;
  els.modelTrigger.disabled = isGenerating || modelSwitchPending;
  els.speedRange.disabled = !ready || isGenerating;
  els.textInput.disabled = isGenerating;
  if (isGenerating) {
    closeVoiceMenu();
    closeModelMenu();
  }
}

function hideOverlay() {
  if (!els.overlay) return;
  els.overlay.classList.add("is-hidden");
  els.overlay.hidden = true;
}

function showOverlay(message = "Loading local model…") {
  if (!els.overlay) return;
  els.overlay.hidden = false;
  els.overlay.classList.remove("is-hidden");
  els.loadingMessage.textContent = message;
  els.progressBar.style.width = "0%";
  els.progressDetail.textContent = "0%";
  els.progressBar.style.width = "8%";
}

/** Idle UI: no model loaded yet — user must set library first. */
function enterSetupMode(message) {
  ready = false;
  modelSwitchPending = false;
  hideOverlay();
  if (els.generateBtn) els.generateBtn.disabled = true;
  if (els.voiceTrigger) els.voiceTrigger.disabled = true;
  // Model picker stays enabled so Download / select works
  if (els.modelTrigger) els.modelTrigger.disabled = false;
  if (els.deviceBadge) els.deviceBadge.textContent = "device: — · no model loaded";
  setStatus(
    message ||
      "Set Storage → Model library folder first, then Download a model and select it to load.",
  );
}

function showSetupModal(errorText = "") {
  if (!els.setupModal) return;
  els.setupModal.hidden = false;
  els.setupModal.classList.remove("is-hidden");
  if (els.setupModalError) {
    if (errorText) {
      els.setupModalError.hidden = false;
      els.setupModalError.textContent = errorText;
    } else {
      els.setupModalError.hidden = true;
      els.setupModalError.textContent = "";
    }
  }
  // Focus primary action for keyboard users
  queueMicrotask(() => els.setupChooseFolderBtn?.focus());
}

function hideSetupModal() {
  if (!els.setupModal) return;
  els.setupModal.classList.add("is-hidden");
  els.setupModal.hidden = true;
  if (els.setupModalError) {
    els.setupModalError.hidden = true;
    els.setupModalError.textContent = "";
  }
}

function openStorageSection() {
  const details = document.getElementById("save-settings");
  if (details) {
    details.open = true;
    details.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  els.pickModelLibBtn?.focus();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function voiceLabel(id, meta) {
  if (!meta) return id;

  const name = meta.name || id;
  const gender = meta.gender ? ` · ${meta.gender}` : "";
  let region = "";
  if (meta.language === "en-us") region = "American";
  else if (meta.language === "en-gb") region = "British";
  else if (meta.language) region = meta.language;

  return region ? `${name} (${region}${gender})` : `${name}${gender}`;
}

function languageGroup(meta) {
  if (meta?.language === "en-us") return "American English";
  if (meta?.language === "en-gb") return "British English";
  return meta?.language || "Other";
}

function shortVoiceMeta(meta) {
  if (!meta) return "";
  const bits = [];
  if (meta.gender) bits.push(meta.gender);
  if (meta.language === "en-us") bits.push("US");
  else if (meta.language === "en-gb") bits.push("UK");
  return bits.join(" · ");
}

function setSelectedVoice(id, { close = true } = {}) {
  if (!id) return;
  selectedVoice = id;
  els.voiceSelect.value = id;

  const match = voiceOptions.find((v) => v.value === id);
  els.voiceTriggerText.textContent = match?.label || id;

  els.voiceMenu.querySelectorAll(".voice-option").forEach((btn) => {
    const selected = btn.dataset.value === id;
    btn.classList.toggle("is-selected", selected);
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  });

  if (close) closeVoiceMenu();
}

function closeVoiceMenu() {
  if (!voiceMenuOpen) return;
  voiceMenuOpen = false;
  els.voiceMenu.hidden = true;
  els.voicePicker.classList.remove("is-open");
  els.voiceTrigger.setAttribute("aria-expanded", "false");
  voiceActiveIndex = -1;
  els.voiceMenu.querySelectorAll(".voice-option.is-active").forEach((el) => {
    el.classList.remove("is-active");
  });
}

function closeModelMenu() {
  if (!modelMenuOpen) return;
  modelMenuOpen = false;
  els.modelMenu.hidden = true;
  els.modelPicker.classList.remove("is-open");
  els.modelTrigger.setAttribute("aria-expanded", "false");
  modelActiveIndex = -1;
  els.modelMenu.querySelectorAll(".voice-option.is-active").forEach((el) => {
    el.classList.remove("is-active");
  });
}

/**
 * True if weights exist in the user-chosen local library folder only.
 * @param {import("./modelCatalog.js").ModelEntry | { key: string }} entry
 */
async function isModelDownloaded(entry) {
  const full = getModelEntry(entry.key || entry);
  if (!modelLibDirHandle) return false;
  const ok = await ensureDirPermission(modelLibDirHandle);
  if (!ok) return false;
  return isEntryInLibrary(modelLibDirHandle, full);
}

/** @type {Map<string, boolean>} */
const modelDownloadStatus = new Map();

/** @type {string | null} */
let modelDownloadingKey = null;

function updateModelDownloadIcons() {
  els.modelMenu.querySelectorAll(".voice-option").forEach((btn) => {
    const key = btn.dataset.value;
    const downloaded = modelDownloadStatus.get(key) === true;
    const isBusy = modelDownloadingKey === key;
    btn.classList.toggle("is-downloaded", downloaded);
    const badge = btn.querySelector(".model-dl-badge");
    if (badge) {
      badge.textContent = downloaded ? "✓" : "☁";
      badge.title = downloaded
        ? "On disk in your model library"
        : "Not on disk — Download into your model library folder";
      badge.classList.toggle("is-local", downloaded);
      badge.classList.toggle("is-remote", !downloaded);
      badge.setAttribute(
        "aria-label",
        downloaded ? "On disk" : "Not on disk",
      );
    }
    const dlBtn = btn.querySelector(".model-download-btn");
    if (dlBtn) {
      dlBtn.hidden = Boolean(downloaded);
      dlBtn.disabled =
        Boolean(downloaded) || isBusy || modelDownloadingKey != null;
      if (!downloaded) {
        dlBtn.textContent = isBusy ? "Downloading…" : "Download";
      }
    }
  });

  // Badge on the closed trigger for the selected model
  let triggerBadge = els.modelTrigger.querySelector(".model-dl-badge");
  if (!triggerBadge) {
    triggerBadge = document.createElement("span");
    triggerBadge.className = "model-dl-badge model-dl-badge-trigger";
    els.modelTriggerText.after(triggerBadge);
  }
  const selDownloaded = modelDownloadStatus.get(selectedModelKey) === true;
  triggerBadge.textContent = selDownloaded ? "✓" : "☁";
  triggerBadge.title = selDownloaded
    ? "On disk in your model library"
    : "Not on disk — Download into your model library folder";
  triggerBadge.classList.toggle("is-local", selDownloaded);
  triggerBadge.classList.toggle("is-remote", !selDownloaded);

  // Inline download under picker — only when selected model is not on disk
  if (els.modelDownloadRow && els.modelDownloadInline) {
    const busy = modelDownloadingKey != null;
    const entry = getModelEntry(selectedModelKey);
    els.modelDownloadRow.hidden = Boolean(selDownloaded);
    els.modelDownloadInline.hidden = Boolean(selDownloaded);
    els.modelDownloadInline.disabled = busy || Boolean(selDownloaded);
    if (!selDownloaded) {
      const dest = modelLibDirHandle
        ? `“${modelLibDirHandle.name}”`
        : "your library folder";
      els.modelDownloadInline.textContent =
        modelDownloadingKey === selectedModelKey
          ? "Downloading…"
          : `Download to ${dest} (${entry.sizeHint})`;
    }
    if (els.modelDownloadProgress) {
      const showProg =
        !selDownloaded && modelDownloadingKey === selectedModelKey;
      els.modelDownloadProgress.hidden = !showProg;
    }
  }

  const entry = getModelEntry(selectedModelKey);
  const statusWord = selDownloaded
    ? "On disk ✓"
    : "Not on disk — use Download";
  els.modelHint.textContent = `${entry.description} · ${entry.sizeHint} · ${statusWord}`;
}

async function refreshModelDownloadStatus() {
  await Promise.all(
    modelOptions.map(async (m) => {
      const ok = await isModelDownloaded(getModelEntry(m.key));
      modelDownloadStatus.set(m.key, ok);
    }),
  );
  updateModelDownloadIcons();
}

/**
 * Download a catalog model into the user-chosen local library folder only.
 * @param {string} key
 */
async function downloadModelToDisk(key) {
  const entry = getModelEntry(key);
  if (modelDownloadingKey) {
    setStatus("Another model download is already running.", "error");
    return;
  }

  if (modelDownloadStatus.get(entry.key)) {
    setStatus(`${entry.shortLabel} is already in your local library.`, "success");
    return;
  }

  if (!modelLibDirHandle) {
    if (!supportsDirPicker) {
      setStatus(
        "Use Chrome or Edge and choose a model library folder under Storage first.",
        "error",
      );
      return;
    }
    const details = document.getElementById("save-settings");
    if (details) details.open = true;
    const picked = await pickModelLibraryFolder();
    if (!picked) return;
  }

  if (!(await ensureDirPermission(modelLibDirHandle))) {
    setStatus("Permission needed to write models into your library folder.", "error");
    return;
  }

  modelDownloadingKey = entry.key;
  updateModelDownloadIcons();
  openModelMenu();
  setStatus(
    `Downloading ${entry.shortLabel} → folder “${modelLibDirHandle.name}”…`,
  );

  const applyProgress = (ev) => {
    const msg = ev.message || `Downloading ${entry.shortLabel}…`;
    setStatus(msg);
    let label = "Downloading…";
    if (ev.loaded != null && ev.total) {
      const pct = Math.round((ev.loaded / ev.total) * 100);
      label = ev.file
        ? `${pct}% · ${String(ev.file).split("/").pop()}`
        : `${pct}%`;
    } else if (ev.file) {
      label = String(ev.file).split("/").pop();
    }
    const dlBtn = els.modelMenu.querySelector(
      `.voice-option[data-value="${entry.key}"] .model-download-btn`,
    );
    if (dlBtn) dlBtn.textContent = label;
    if (els.modelDownloadInline && selectedModelKey === entry.key) {
      els.modelDownloadInline.textContent = `Downloading ${label}`;
    }
    if (els.modelDownloadProgress && selectedModelKey === entry.key) {
      els.modelDownloadProgress.hidden = false;
      els.modelDownloadProgress.textContent = msg;
    }
  };

  try {
    await downloadEntryFiles({
      modelKey: entry.key,
      libraryRoot: modelLibDirHandle,
      returnBuffers: false,
      onProgress: applyProgress,
    });
    sendModelLibraryToWorker();
    await refreshModelLibScan();
    modelDownloadStatus.set(entry.key, true);
    await refreshModelDownloadStatus();
    setStatus(
      `${entry.shortLabel} saved in “${modelLibDirHandle.name}”. Select it in the list to load.`,
      "success",
    );
  } catch (err) {
    console.error(err);
    if (import.meta.env.DEV) {
      try {
        await downloadModelViaDevApi(entry, applyProgress);
        modelDownloadStatus.set(entry.key, true);
        await refreshModelDownloadStatus();
        setStatus(
          `${entry.shortLabel} saved under public/models (dev server).`,
          "success",
        );
        return;
      } catch (e2) {
        setStatus(err?.message || e2?.message || "Download failed.", "error");
      }
    } else {
      setStatus(err?.message || "Download failed.", "error");
    }
  } finally {
    modelDownloadingKey = null;
    updateModelDownloadIcons();
  }
}

/**
 * @param {import("./modelCatalog.js").ModelEntry} entry
 * @param {(ev: object) => void} applyProgress
 */
async function downloadModelViaDevApi(entry, applyProgress) {
  const url = `/api/download-model?key=${encodeURIComponent(entry.key)}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Dev download API failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === "error") throw new Error(ev.message || "Download failed");
      applyProgress(ev);
    }
  }
}

function updateModelLibUi() {
  if (!els.modelLibLabel) return;
  if (!supportsDirPicker) {
    els.modelLibLabel.textContent = "Not supported in this browser";
    if (els.pickModelLibBtn) els.pickModelLibBtn.hidden = true;
    if (els.rescanModelLibBtn) els.rescanModelLibBtn.hidden = true;
    if (els.clearModelLibBtn) els.clearModelLibBtn.hidden = true;
    if (els.modelLibHint) {
      els.modelLibHint.textContent =
        "Use Chrome or Edge to pick a local model folder. Structure is always {folder}/models/…";
    }
    if (els.modelLibScan) els.modelLibScan.hidden = true;
    return;
  }
  if (modelLibDirHandle) {
    els.modelLibLabel.textContent = modelLibDirHandle.name;
    els.modelLibLabel.title = `${modelLibDirHandle.name}/models/…`;
    if (els.clearModelLibBtn) els.clearModelLibBtn.hidden = false;
    if (els.rescanModelLibBtn) els.rescanModelLibBtn.hidden = false;
    if (els.modelLibHint) {
      els.modelLibHint.textContent =
        `Downloads → “${modelLibDirHandle.name}/models/…”. Auto-reads nested packs under this folder.`;
    }
  } else {
    els.modelLibLabel.textContent = "Not set — pick a folder for /models";
    els.modelLibLabel.title = "";
    if (els.clearModelLibBtn) els.clearModelLibBtn.hidden = true;
    if (els.rescanModelLibBtn) els.rescanModelLibBtn.hidden = true;
    if (els.modelLibHint) {
      els.modelLibHint.textContent =
        "Chrome / Edge: choose a root folder. Writes {folder}/models/{model-id}/… and scans nested folders automatically.";
    }
    if (els.modelLibScan) {
      els.modelLibScan.hidden = true;
      els.modelLibScan.textContent = "";
    }
  }
}

async function refreshModelLibScan() {
  if (!els.modelLibScan || !modelLibDirHandle) {
    if (els.modelLibScan) {
      els.modelLibScan.hidden = true;
      els.modelLibScan.textContent = "";
    }
    return;
  }
  if (!(await ensureDirPermission(modelLibDirHandle))) {
    els.modelLibScan.hidden = false;
    els.modelLibScan.textContent = "Need folder permission to scan.";
    return;
  }
  try {
    const scan = await scanLibraryCatalog(modelLibDirHandle);
    const present = scan.models.filter((m) => m.present).map((m) => m.shortLabel);
    const missing = scan.models.filter((m) => !m.present).map((m) => m.shortLabel);
    const lines = [
      `Root: ${modelLibDirHandle.name}/ (auto-reads nested models/)`,
      present.length
        ? `Found: ${present.join(", ")}`
        : "Found: (none yet — use Download)",
      scan.packPaths?.length
        ? `Nested packs: ${scan.packPaths.slice(0, 8).join(", ")}${scan.packPaths.length > 8 ? "…" : ""}`
        : null,
      missing.length ? `Missing: ${missing.join(", ")}` : null,
    ].filter(Boolean);
    els.modelLibScan.hidden = false;
    els.modelLibScan.textContent = lines.join("\n");
  } catch (e) {
    els.modelLibScan.hidden = false;
    els.modelLibScan.textContent = e?.message || "Scan failed.";
  }
}

async function pickModelLibraryFolder({ fromSetupModal = false } = {}) {
  if (!supportsDirPicker) {
    const msg =
      "Folder picker needs Chrome or Edge. Use one of those browsers to choose where models are saved.";
    if (fromSetupModal) showSetupModal(msg);
    setStatus(msg, "error");
    return false;
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: "knull-clear-model-library",
      mode: "readwrite",
      startIn: "documents",
    });
    if (!(await ensureDirPermission(handle))) {
      const msg = "Permission denied for that folder. Pick another location.";
      if (fromSetupModal) showSetupModal(msg);
      setStatus(msg, "error");
      return false;
    }
    modelLibDirHandle = handle;
    await idbSet(IDB_MODEL_LIB_KEY, handle);
    updateModelLibUi();
    sendModelLibraryToWorker();
    await refreshModelLibScan();
    await refreshModelDownloadStatus();
    // Do not auto-load weights — user downloads/selects after setting the folder
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
    }
    hideSetupModal();
    enterSetupMode(
      `Models will be saved under “${handle.name}/models/…”. Download a model, then select it to load.`,
    );
    return true;
  } catch (e) {
    if (e?.name === "AbortError") {
      if (fromSetupModal) {
        showSetupModal(
          "No folder selected yet. Choose a folder to continue — models are stored only on your PC.",
        );
      }
      return false;
    }
    const msg = e?.message || "Could not open folder picker.";
    if (fromSetupModal) showSetupModal(msg);
    setStatus(msg, "error");
    return false;
  }
}

async function clearModelLibraryFolder() {
  modelLibDirHandle = null;
  try {
    await idbDelete(IDB_MODEL_LIB_KEY);
  } catch {
    /* ignore */
  }
  updateModelLibUi();
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
  await refreshModelDownloadStatus();
  enterSetupMode(
    "Model library cleared. Choose where models should be saved on your PC.",
  );
  showSetupModal();
}

function sendModelLibraryToWorker() {
  if (!worker) return;
  try {
    worker.postMessage({
      type: "set-model-library",
      handle: modelLibDirHandle || null,
    });
  } catch (e) {
    console.warn("Could not send model library to worker:", e);
  }
}

async function setSelectedModel(key, { load = false } = {}) {
  const entry = getModelEntry(key);
  selectedModelKey = entry.key;
  els.modelSelect.value = entry.key;
  els.modelTriggerText.textContent = entry.label;

  els.modelMenu.querySelectorAll(".voice-option").forEach((btn) => {
    const selected = btn.dataset.value === entry.key;
    btn.classList.toggle("is-selected", selected);
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  });
  updateModelDownloadIcons();

  try {
    localStorage.setItem(STORAGE_KEYS.modelKey, entry.key);
  } catch {
    /* ignore */
  }

  closeModelMenu();

  if (load) {
    if (!modelLibDirHandle) {
      const details = document.getElementById("save-settings");
      if (details) details.open = true;
      showSetupModal(
        "Choose a model library folder first, Download the model, then load it.",
      );
      setStatus(
        "Choose a model library folder under Storage first (where models are stored locally).",
        "error",
      );
      return;
    }
    // Refresh permission before worker load (needs user gesture)
    if (!(await ensureDirPermission(modelLibDirHandle))) {
      setStatus(
        "Folder permission expired. Click Choose folder… again under Storage.",
        "error",
      );
      openStorageSection();
      return;
    }
    ready = false;
    modelSwitchPending = true;
    setGenerating(false);
    els.generateBtn.disabled = true;
    els.voiceTrigger.disabled = true;
    els.modelTrigger.disabled = true;
    showOverlay(`Loading ${entry.shortLabel} from your folder…`);
    setStatus(`Loading ${entry.shortLabel} from local library…`);
    startWorker(entry.key, { autoLoad: true });
  }
}

function openModelMenu() {
  if (els.modelTrigger.disabled || modelOptions.length === 0) return;
  closeVoiceMenu();
  modelMenuOpen = true;
  els.modelMenu.hidden = false;
  els.modelPicker.classList.add("is-open");
  els.modelTrigger.setAttribute("aria-expanded", "true");
  const idx = Math.max(
    0,
    modelOptions.findIndex((m) => m.key === selectedModelKey),
  );
  setModelActiveIndex(idx);
}

function toggleModelMenu() {
  if (modelMenuOpen) closeModelMenu();
  else openModelMenu();
}

function setModelActiveIndex(index) {
  if (modelOptions.length === 0) return;
  const next = Math.max(0, Math.min(modelOptions.length - 1, index));
  modelActiveIndex = next;
  const buttons = [...els.modelMenu.querySelectorAll(".voice-option")];
  buttons.forEach((btn, i) => {
    btn.classList.toggle("is-active", i === next);
  });
  buttons[next]?.scrollIntoView({ block: "nearest" });
}

function populateModelMenu() {
  els.modelMenu.innerHTML = "";
  modelOptions.forEach((m, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-option";
    btn.role = "option";
    btn.dataset.value = m.key;
    btn.dataset.index = String(index);
    btn.setAttribute("aria-selected", "false");

    const top = document.createElement("div");
    top.className = "model-option-top";

    const nameRow = document.createElement("span");
    nameRow.className = "model-option-name-row";

    const badge = document.createElement("span");
    badge.className = "model-dl-badge is-remote";
    badge.textContent = "…";
    badge.title = "Checking…";

    const name = document.createElement("span");
    name.className = "voice-option-name";
    name.textContent = m.label;

    nameRow.append(badge, name);

    const right = document.createElement("span");
    right.className = "model-option-right";

    const size = document.createElement("span");
    size.className = "model-option-size";
    size.textContent = `${m.dtype} · ${m.sizeHint}`;

    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn btn-secondary btn-sm model-download-btn";
    dlBtn.textContent = "Download";
    dlBtn.title = "Download into your local model library folder";
    // Hidden until status is known; stays hidden if already on disk
    dlBtn.hidden = true;
    dlBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadModelToDisk(m.key).catch((err) =>
        setStatus(err?.message || "Download failed.", "error"),
      );
    });

    right.append(size, dlBtn);
    top.append(nameRow, right);

    const desc = document.createElement("span");
    desc.className = "model-option-desc";
    desc.textContent = m.description;

    btn.append(top, desc);
    btn.addEventListener("click", (e) => {
      // Don't treat download clicks as model select
      if (e.target.closest(".model-download-btn")) return;
      if (m.key === selectedModelKey && ready) {
        closeModelMenu();
        return;
      }
      setSelectedModel(m.key, { load: true });
    });
    btn.addEventListener("mousemove", () => setModelActiveIndex(index));
    els.modelMenu.appendChild(btn);
  });

  let saved = DEFAULT_MODEL_KEY;
  try {
    saved = localStorage.getItem(STORAGE_KEYS.modelKey) || DEFAULT_MODEL_KEY;
  } catch {
    /* ignore */
  }
  setSelectedModel(saved, { load: false });
  // Async probe for local ONNX files → ✓ / ☁ icons
  refreshModelDownloadStatus().catch(() => {});
}

function openVoiceMenu() {
  if (els.voiceTrigger.disabled || voiceOptions.length === 0) return;
  closeModelMenu();
  voiceMenuOpen = true;
  els.voiceMenu.hidden = false;
  els.voicePicker.classList.add("is-open");
  els.voiceTrigger.setAttribute("aria-expanded", "true");

  const idx = Math.max(
    0,
    voiceOptions.findIndex((v) => v.value === selectedVoice),
  );
  setVoiceActiveIndex(idx);
}

function toggleVoiceMenu() {
  if (voiceMenuOpen) closeVoiceMenu();
  else openVoiceMenu();
}

function setVoiceActiveIndex(index) {
  if (voiceOptions.length === 0) return;
  const next = Math.max(0, Math.min(voiceOptions.length - 1, index));
  voiceActiveIndex = next;
  const buttons = [...els.voiceMenu.querySelectorAll(".voice-option")];
  buttons.forEach((btn, i) => {
    btn.classList.toggle("is-active", i === next);
  });
  buttons[next]?.scrollIntoView({ block: "nearest" });
}

/**
 * @param {Record<string, { name?: string, language?: string, gender?: string }>} voices
 */
function populateVoices(voices) {
  const entries = Object.entries(voices || {});
  els.voiceMenu.innerHTML = "";
  voiceOptions = [];

  /** @type {Map<string, [string, object|null][]>} */
  const groups = new Map();

  if (entries.length === 0) {
    const fallback = [
      "af_heart",
      "af_bella",
      "af_nicole",
      "af_sarah",
      "am_adam",
      "am_michael",
      "bf_emma",
      "bm_george",
    ];
    groups.set(
      "Voices",
      fallback.map((id) => /** @type {[string, null]} */ ([id, null])),
    );
  } else {
    for (const [id, meta] of entries) {
      const lang = languageGroup(meta);
      if (!groups.has(lang)) groups.set(lang, []);
      groups.get(lang).push([id, meta]);
    }
  }

  for (const [lang, items] of groups) {
    const label = document.createElement("div");
    label.className = "voice-group-label";
    label.textContent = lang;
    els.voiceMenu.appendChild(label);

    for (const [id, meta] of items.sort((a, b) => a[0].localeCompare(b[0]))) {
      const fullLabel = voiceLabel(id, meta);
      voiceOptions.push({ value: id, label: fullLabel, group: lang });

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-option";
      btn.role = "option";
      btn.dataset.value = id;
      btn.dataset.index = String(voiceOptions.length - 1);
      btn.setAttribute("aria-selected", "false");

      const name = document.createElement("span");
      name.className = "voice-option-name";
      name.textContent = meta?.name || id;

      const metaEl = document.createElement("span");
      metaEl.className = "voice-option-meta";
      metaEl.textContent = shortVoiceMeta(meta) || id;

      btn.append(name, metaEl);
      btn.addEventListener("click", () => setSelectedVoice(id));
      btn.addEventListener("mousemove", () => {
        setVoiceActiveIndex(Number(btn.dataset.index));
      });
      els.voiceMenu.appendChild(btn);
    }
  }

  const initial =
    (voices && voices.af_heart && "af_heart") ||
    voiceOptions[0]?.value ||
    "af_heart";
  setSelectedVoice(initial, { close: true });
  els.voiceTrigger.disabled = !ready || generating;
}

/* ── IndexedDB helpers for directory handle ───────────────────────── */

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function ensureDirPermission(handle) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
  } catch {
    /* permission API may throw if user activation missing */
  }
  return false;
}

function updateFolderUi() {
  if (!supportsDirPicker) {
    els.folderLabel.textContent = "Browser Downloads (default)";
    els.pickFolderBtn.hidden = true;
    els.clearFolderBtn.hidden = true;
    els.folderHint.textContent =
      "This browser does not support choosing a save folder. Files use the normal download dialog.";
    return;
  }

  if (saveDirHandle) {
    els.folderLabel.textContent = saveDirHandle.name;
    els.folderLabel.title = saveDirHandle.name;
    els.clearFolderBtn.hidden = false;
    els.folderHint.textContent =
      "WAVs will be written into this folder (with permission). Click “Use default” to revert.";
  } else {
    els.folderLabel.textContent = "Browser Downloads (default)";
    els.folderLabel.title = "";
    els.clearFolderBtn.hidden = true;
    els.folderHint.textContent =
      "Pick a folder to save WAVs there (Chrome / Edge). Other browsers use the normal download dialog.";
  }
}

async function restoreSaveDirectory() {
  if (!supportsDirPicker) {
    updateFolderUi();
    updateModelLibUi();
    return;
  }
  try {
    const handle = await idbGet(IDB_DIR_KEY);
    if (handle) saveDirHandle = handle;
  } catch (e) {
    console.warn("Could not restore save folder:", e);
    saveDirHandle = null;
  }
  try {
    const lib = await idbGet(IDB_MODEL_LIB_KEY);
    if (lib) modelLibDirHandle = lib;
  } catch (e) {
    console.warn("Could not restore model library:", e);
    modelLibDirHandle = null;
  }
  updateFolderUi();
  updateModelLibUi();
  await refreshModelLibScan().catch(() => {});
  await refreshModelDownloadStatus().catch(() => {});
}

async function pickSaveDirectory() {
  if (!supportsDirPicker) {
    setStatus("Folder picker is not supported in this browser.", "error");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: "knull-clear-wav-output",
      mode: "readwrite",
      startIn: "downloads",
    });
    const ok = await ensureDirPermission(handle);
    if (!ok) {
      setStatus("Permission to write to that folder was denied.", "error");
      return;
    }
    saveDirHandle = handle;
    await idbSet(IDB_DIR_KEY, handle);
    updateFolderUi();
    setStatus(`Save folder set to “${handle.name}”.`, "success");
  } catch (e) {
    if (e?.name === "AbortError") return;
    console.error(e);
    setStatus(e?.message || "Could not open folder picker.", "error");
  }
}

async function clearSaveDirectory() {
  saveDirHandle = null;
  try {
    await idbDelete(IDB_DIR_KEY);
  } catch {
    /* ignore */
  }
  updateFolderUi();
  setStatus("Save folder reset to browser Downloads.", "success");
}

function sanitizeFilenamePart(value, fallback = "speech") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function buildWavFilename(item) {
  const prefix = sanitizeFilenamePart(
    els.filenamePrefix.value.trim() || "knull-clear",
    "knull-clear",
  );
  const voice = sanitizeFilenamePart(item?.voice || "speech", "speech");
  const stamp = new Date(item?.createdAt || Date.now())
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return `${prefix}-${voice}-${stamp}.wav`;
}

function browserDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoke so the download can start
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/**
 * Save a WAV to the chosen directory, or fall back to browser Downloads.
 * @param {HistoryItem} item
 */
async function saveWav(item) {
  if (!item?.blob) return;

  const filename = buildWavFilename(item);

  if (saveDirHandle) {
    const permitted = await ensureDirPermission(saveDirHandle);
    if (permitted) {
      try {
        const fileHandle = await saveDirHandle.getFileHandle(filename, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(item.blob);
        await writable.close();
        setStatus(`Saved ${filename} → ${saveDirHandle.name}/`, "success");
        return;
      } catch (e) {
        console.error(e);
        setStatus(
          `Could not write to folder (${e?.message || e}). Using browser download…`,
          "error",
        );
      }
    } else {
      setStatus(
        "Folder permission needed — using browser download. Re-choose the folder if you want direct saves.",
        "error",
      );
    }
  }

  browserDownloadBlob(item.blob, filename);
  setStatus(`Downloading ${filename}…`, "success");
}

/* ── History ──────────────────────────────────────────────────────── */

function revokeEntry(entry) {
  if (entry?.url) {
    try {
      URL.revokeObjectURL(entry.url);
    } catch {
      /* already revoked */
    }
  }
}

function renderHistory() {
  els.resultsList.innerHTML = "";
  els.clearHistoryBtn.hidden = history.length === 0;
  els.downloadBtn.disabled = !latest;

  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<div class="empty-icon" aria-hidden="true">♪</div><p>Generated audio will appear here</p>';
    els.resultsList.appendChild(empty);
    return;
  }

  history.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "result-card";
    card.dataset.id = item.id;

    const header = document.createElement("div");
    header.className = "result-header";

    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.innerHTML = `
      <span>#${history.length - index}</span>
      <span>${escapeHtml(item.voice)}</span>
      <span>${item.speed.toFixed(2)}×</span>
    `.trim();

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-secondary btn-sm";
    saveBtn.textContent = "Save";
    saveBtn.title = "Save this WAV";
    saveBtn.addEventListener("click", () => {
      saveWav(item).catch((e) => {
        setStatus(e?.message || "Save failed.", "error");
      });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger btn-sm";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Remove this clip from history";
    deleteBtn.addEventListener("click", () => deleteHistoryItem(item.id));

    actions.append(saveBtn, deleteBtn);
    header.append(meta, actions);

    const text = document.createElement("p");
    text.className = "result-text";
    text.textContent = item.text;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = item.url;
    if (index === 0) audio.autoplay = true;

    card.append(header, text, audio);
    els.resultsList.appendChild(card);
  });
}

function deleteHistoryItem(id) {
  const idx = history.findIndex((h) => h.id === id);
  if (idx < 0) return;

  const [removed] = history.splice(idx, 1);
  revokeEntry(removed);

  if (latest?.id === id) {
    latest = history[0] || null;
  }

  renderHistory();
  setStatus(
    history.length === 0 ? "History empty." : "Clip deleted from history.",
    "success",
  );
}

function clearHistory() {
  for (const item of history) revokeEntry(item);
  history = [];
  latest = null;
  renderHistory();
  setStatus("History cleared.", "success");
}

/**
 * @param {Blob} blob
 * @param {string} text
 * @param {string} voice
 * @param {number} speed
 */
function setLatestAudio(blob, text, voice, speed) {
  // Do not revoke previous URLs here — they still live in history until deleted.
  const url = URL.createObjectURL(blob);
  /** @type {HistoryItem} */
  const entry = {
    id: crypto.randomUUID(),
    url,
    blob,
    text,
    voice,
    speed,
    createdAt: Date.now(),
  };

  latest = entry;
  history.unshift(entry);

  while (history.length > 12) {
    const removed = history.pop();
    if (removed && removed.id !== entry.id) revokeEntry(removed);
  }

  renderHistory();
}

function clearText() {
  els.textInput.value = "";
  updateCharCount();
  setGenerating(false);
  els.textInput.focus();
}

function generate() {
  if (!worker || !ready || generating) return;

  const text = els.textInput.value.trim();
  if (!text) {
    setStatus("Please enter some text to speak.", "error");
    return;
  }

  setGenerating(true);
  setStatus("Generating speech… this may take a few seconds on first run.");

  worker.postMessage({
    type: "generate",
    text,
    voice: selectedVoice || els.voiceSelect.value || "af_heart",
    speed: Number(els.speedRange.value) || 1,
  });
}

function handleWorkerMessage(event) {
  const data = event.data || {};

  switch (data.type) {
    case "worker-ready": {
      // Attach library first, then load (order matters for offline path)
      sendModelLibraryToWorker();
      if (pendingWorkerModelKey) {
        const key = pendingWorkerModelKey;
        pendingWorkerModelKey = null;
        // Brief delay so set-model-library is processed before load-model
        queueMicrotask(() => {
          worker?.postMessage({ type: "load-model", modelKey: key });
        });
      } else {
        hideOverlay();
      }
      break;
    }
    case "status": {
      if (data.message) {
        els.loadingMessage.textContent = data.message;
        if (!ready || modelSwitchPending) setStatus(data.message);
      }
      if (data.device) {
        const dtype = data.dtype ? ` · ${data.dtype}` : "";
        const modelBit = data.modelLabel
          ? ` · ${getModelEntry(data.modelKey || selectedModelKey).shortLabel}`
          : "";
        els.deviceBadge.textContent = `device: ${data.device}${dtype}${modelBit}`;
      }
      break;
    }
    case "progress": {
      const pct = Number(data.progress) || 0;
      els.progressBar.style.width = `${pct}%`;
      els.progressDetail.textContent = data.detail
        ? `${Math.round(pct)}% · ${data.detail}`
        : `${Math.round(pct)}%`;
      if (data.detail) {
        // Prefer human detail over raw filename (avoids "stuck" on tokenizer at 100%)
        els.loadingMessage.textContent = data.detail;
      } else if (data.file) {
        els.loadingMessage.textContent = `Loading ${data.file}`;
      }
      break;
    }
    case "ready": {
      ready = true;
      modelSwitchPending = false;
      if (data.modelKey) {
        selectedModelKey = data.modelKey;
        els.modelSelect.value = data.modelKey;
        const entry = getModelEntry(data.modelKey);
        els.modelTriggerText.textContent = entry.label;
        els.modelHint.textContent = `${entry.description} · ${entry.sizeHint}`;
        els.modelMenu.querySelectorAll(".voice-option").forEach((btn) => {
          const selected = btn.dataset.value === data.modelKey;
          btn.classList.toggle("is-selected", selected);
        });
      }
      populateVoices(data.voices);
      if (data.device) {
        const dtype = data.dtype ? ` · ${data.dtype}` : "";
        const srcRaw = String(data.source || "");
        const src = srcRaw
          ? srcRaw.startsWith("library")
            ? " · local library"
            : ` · ${srcRaw}`
          : "";
        const modelBit = data.modelShortLabel
          ? ` · ${data.modelShortLabel}`
          : "";
        els.deviceBadge.textContent = `device: ${data.device}${dtype}${src}${modelBit}`;
      }
      els.progressBar.style.width = "100%";
      els.progressDetail.textContent = "100% · Ready";
      els.loadingMessage.textContent = "Model ready";
      els.modelTrigger.disabled = false;
      setGenerating(false);
      setStatus(
        `Ready — ${data.modelShortLabel || "model"} loaded (offline). Enter text and generate.`,
        "success",
      );
      refreshModelDownloadStatus().catch(() => {});
      refreshModelLibScan().catch(() => {});
      setTimeout(hideOverlay, 350);
      break;
    }
    case "complete": {
      const blob = new Blob([data.buffer], {
        type: data.mimeType || "audio/wav",
      });
      setLatestAudio(blob, data.text, data.voice, data.speed);
      setGenerating(false);
      setStatus("Speech generated successfully.", "success");

      if (els.autoSave.checked && latest) {
        saveWav(latest).catch((e) => {
          setStatus(e?.message || "Auto-save failed.", "error");
        });
      }
      break;
    }
    case "error": {
      setGenerating(false);
      modelSwitchPending = false;
      if (els.modelTrigger) els.modelTrigger.disabled = false;
      const message = data.message || "Something went wrong.";
      setStatus(message, "error");
      if (!ready) {
        if (els.loadingMessage) els.loadingMessage.textContent = message;
        if (els.progressDetail) els.progressDetail.textContent = "Failed";
      }
      // Don't leave the startup-style overlay stuck on failure
      hideOverlay();
      break;
    }
    default:
      break;
  }
}

function handleWorkerError(error) {
  console.error("Worker error:", error);
  const message = error?.message || "Worker failed to start.";
  setStatus(message, "error");
  if (els.loadingMessage) els.loadingMessage.textContent = message;
  setGenerating(false);
  modelSwitchPending = false;
  if (els.modelTrigger) els.modelTrigger.disabled = false;
  hideOverlay();
}

function loadLocalSettings() {
  try {
    const prefix = localStorage.getItem(STORAGE_KEYS.filenamePrefix);
    if (prefix != null) els.filenamePrefix.value = prefix;
    else els.filenamePrefix.value = "knull-clear";

    els.autoSave.checked = localStorage.getItem(STORAGE_KEYS.autoSave) === "1";
  } catch {
    els.filenamePrefix.value = "knull-clear";
  }
}

function bindEvents() {
  els.textInput.addEventListener("input", () => {
    updateCharCount();
    if (ready && !generating) {
      els.generateBtn.disabled = !els.textInput.value.trim();
    }
  });

  els.speedRange.addEventListener("input", updateSpeedLabel);

  els.generateBtn.addEventListener("click", generate);
  els.downloadBtn.addEventListener("click", () => {
    if (!latest) return;
    saveWav(latest).catch((e) => setStatus(e?.message || "Save failed.", "error"));
  });
  els.clearBtn.addEventListener("click", clearText);
  els.clearHistoryBtn.addEventListener("click", clearHistory);

  els.voiceTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleVoiceMenu();
  });
  els.voiceTrigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!voiceMenuOpen) openVoiceMenu();
      else if (e.key === "ArrowDown") setVoiceActiveIndex(voiceActiveIndex + 1);
      else if (e.key === "Enter" || e.key === " ") {
        const opt = voiceOptions[voiceActiveIndex];
        if (opt) setSelectedVoice(opt.value);
      }
    } else if (e.key === "Escape") {
      closeVoiceMenu();
    } else if (e.key === "ArrowUp" && voiceMenuOpen) {
      e.preventDefault();
      setVoiceActiveIndex(voiceActiveIndex - 1);
    }
  });
  els.voiceMenu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setVoiceActiveIndex(voiceActiveIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setVoiceActiveIndex(voiceActiveIndex - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = voiceOptions[voiceActiveIndex];
      if (opt) setSelectedVoice(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeVoiceMenu();
      els.voiceTrigger.focus();
    }
  });

  els.modelDownloadInline?.addEventListener("click", () => {
    downloadModelToDisk(selectedModelKey).catch((e) =>
      setStatus(e?.message || "Download failed.", "error"),
    );
  });

  els.modelTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });
  els.modelTrigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!modelMenuOpen) openModelMenu();
      else if (e.key === "ArrowDown") setModelActiveIndex(modelActiveIndex + 1);
      else if (e.key === "Enter" || e.key === " ") {
        const opt = modelOptions[modelActiveIndex];
        if (opt) {
          if (opt.key === selectedModelKey && ready) closeModelMenu();
          else setSelectedModel(opt.key, { load: true });
        }
      }
    } else if (e.key === "Escape") {
      closeModelMenu();
    } else if (e.key === "ArrowUp" && modelMenuOpen) {
      e.preventDefault();
      setModelActiveIndex(modelActiveIndex - 1);
    }
  });

  document.addEventListener("click", (e) => {
    const t = /** @type {Node} */ (e.target);
    if (!els.voicePicker.contains(t)) closeVoiceMenu();
    if (!els.modelPicker.contains(t)) closeModelMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (voiceMenuOpen) closeVoiceMenu();
      if (modelMenuOpen) closeModelMenu();
    }
  });

  els.pickFolderBtn.addEventListener("click", () => {
    pickSaveDirectory().catch((e) =>
      setStatus(e?.message || "Folder picker failed.", "error"),
    );
  });
  els.clearFolderBtn.addEventListener("click", () => {
    clearSaveDirectory().catch(() => {});
  });

  els.pickModelLibBtn?.addEventListener("click", () => {
    pickModelLibraryFolder().catch((e) =>
      setStatus(e?.message || "Model library picker failed.", "error"),
    );
  });
  els.setupChooseFolderBtn?.addEventListener("click", () => {
    pickModelLibraryFolder({ fromSetupModal: true }).catch((e) => {
      showSetupModal(e?.message || "Folder picker failed.");
    });
  });
  els.setupOpenStorageBtn?.addEventListener("click", () => {
    hideSetupModal();
    openStorageSection();
    setStatus(
      "Open Storage → Choose folder… to set where models are saved on your PC.",
    );
  });
  els.rescanModelLibBtn?.addEventListener("click", () => {
    refreshModelLibScan()
      .then(() => refreshModelDownloadStatus())
      .then(() => setStatus("Model library rescanned.", "success"))
      .catch((e) => setStatus(e?.message || "Rescan failed.", "error"));
  });
  els.clearModelLibBtn?.addEventListener("click", () => {
    clearModelLibraryFolder().catch(() => {});
  });
  els.filenamePrefix.addEventListener("change", () => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.filenamePrefix,
        els.filenamePrefix.value.trim() || "knull-clear",
      );
    } catch {
      /* ignore */
    }
  });
  els.autoSave.addEventListener("change", () => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.autoSave,
        els.autoSave.checked ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  });

  els.textInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });
}

/**
 * Create (or recreate) the inference worker.
 * @param {string} [modelKey] if set with autoLoad, loads that model after ready
 * @param {{ autoLoad?: boolean }} [opts]
 */
function startWorker(modelKey, opts = {}) {
  // Only load weights when explicitly requested (never on cold start)
  const autoLoad = opts.autoLoad === true;
  pendingWorkerModelKey = autoLoad
    ? modelKey || selectedModelKey || DEFAULT_MODEL_KEY
    : null;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
  }
  ready = false;
  worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", handleWorkerError);
}

async function main() {
  updateCharCount();
  updateSpeedLabel();
  loadLocalSettings();
  populateModelMenu();
  bindEvents();
  await restoreSaveDirectory();

  // No startup model load — library folder first
  hideOverlay();
  if (els.modelTrigger) els.modelTrigger.disabled = false;
  if (els.generateBtn) els.generateBtn.disabled = true;
  if (els.voiceTrigger) els.voiceTrigger.disabled = true;
  if (els.deviceBadge) els.deviceBadge.textContent = "device: — · setup";

  // If we have a saved handle, confirm permission still works
  if (modelLibDirHandle) {
    const ok = await ensureDirPermission(modelLibDirHandle);
    if (!ok) {
      modelLibDirHandle = null;
      try {
        await idbDelete(IDB_MODEL_LIB_KEY);
      } catch {
        /* ignore */
      }
      updateModelLibUi();
    }
  }

  if (!modelLibDirHandle) {
    enterSetupMode(
      "First visit: choose where TTS models should be saved on your PC.",
    );
    openStorageSection();
    // Folder picker requires a click — show a clear first-run dialog
    if (supportsDirPicker) {
      showSetupModal();
    } else {
      showSetupModal(
        "This browser cannot pick folders. Open the app in Chrome or Edge to choose a model save location.",
      );
    }
  } else {
    hideSetupModal();
    enterSetupMode(
      `Models save to “${modelLibDirHandle.name}”. Download if needed, then select a model to load.`,
    );
  }
}

main();
