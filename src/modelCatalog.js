/**
 * TTS model catalog for Knull & Clear.
 * All entries use kokoro-js (StyleTTS2 / Kokoro ONNX family).
 */

/** @typedef {"q8"|"fp32"|"q4"|"fp16"|"q4f16"} ModelDtype */
/** @typedef {"auto"|"wasm"|"webgpu"} ModelDevicePref */

/**
 * @typedef {Object} ModelEntry
 * @property {string} key
 * @property {string} label
 * @property {string} shortLabel
 * @property {string} description
 * @property {string} modelId  Hugging Face / local models path id
 * @property {ModelDtype} dtype
 * @property {ModelDevicePref} devicePref
 * @property {string} sizeHint
 * @property {string} quality  "balanced" | "high" | "compact"
 * @property {boolean} [localVoices] whether English voices are under public/models
 */

/** @type {ModelEntry[]} */
export const MODEL_CATALOG = [
  {
    key: "kokoro-v1-balanced",
    label: "Kokoro 82M v1 · Balanced",
    shortLabel: "Balanced (q8)",
    description: "Best default. Self-hosted q8 weights, accurate on WASM.",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "q8",
    devicePref: "wasm",
    sizeHint: "~90 MB",
    quality: "balanced",
    localVoices: true,
  },
  {
    key: "kokoro-v1-quality",
    label: "Kokoro 82M v1 · High quality",
    shortLabel: "High quality (fp32)",
    description: "Full precision. Best fidelity; uses WebGPU when available.",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "fp32",
    devicePref: "auto",
    sizeHint: "~325 MB",
    quality: "high",
    localVoices: true,
  },
  {
    key: "kokoro-v1-compact",
    label: "Kokoro 82M v1 · Compact",
    shortLabel: "Compact (q4)",
    description: "Smaller / faster quantized weights. Needs local q4 files.",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "q4",
    devicePref: "wasm",
    sizeHint: "~50 MB",
    quality: "compact",
    localVoices: true,
  },
  {
    key: "kokoro-original",
    label: "Kokoro 82M · Original",
    shortLabel: "Original (q8)",
    description: "Earlier ONNX export. Requires a local original pack.",
    modelId: "onnx-community/Kokoro-82M-ONNX",
    dtype: "q8",
    devicePref: "wasm",
    sizeHint: "~90 MB",
    quality: "balanced",
    localVoices: false,
  },
];

export const DEFAULT_MODEL_KEY = "kokoro-v1-balanced";

/** English voices stored next to the model for offline use. */
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

/**
 * Relative files to download for a catalog entry into the user library.
 * @param {ModelEntry} entry
 */
export function filesForModelEntry(entry) {
  const files = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    `onnx/${onnxFileForDtype(entry.dtype)}`,
  ];
  if (entry.dtype !== "q8") {
    files.push(`onnx/${onnxFileForDtype("q8")}`);
  }
  if (entry.localVoices !== false) {
    for (const v of ENGLISH_VOICES) files.push(`voices/${v}.bin`);
  }
  return [...new Set(files)];
}

/** @param {string} key */
export function getModelEntry(key) {
  return (
    MODEL_CATALOG.find((m) => m.key === key) ||
    MODEL_CATALOG.find((m) => m.key === DEFAULT_MODEL_KEY) ||
    MODEL_CATALOG[0]
  );
}

/** @param {string} dtype */
export function onnxFileForDtype(dtype) {
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
 * Public URL path for a catalog entry's ONNX weights (under Vite public/).
 * @param {ModelEntry} entry
 * @param {string} [baseUrl="/"]
 */
export function localOnnxPublicPath(entry, baseUrl = "/") {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const file = onnxFileForDtype(entry.dtype);
  const rel = `models/${entry.modelId}/onnx/${file}`;
  if (base === "/") return `/${rel}`;
  return `${base}${rel}`.replace(/([^:]\/)\/+/g, "$1");
}

export function listModelsForUi() {
  return MODEL_CATALOG.map((m) => ({
    key: m.key,
    label: m.label,
    shortLabel: m.shortLabel,
    description: m.description,
    sizeHint: m.sizeHint,
    quality: m.quality,
    dtype: m.dtype,
    modelId: m.modelId,
  }));
}
