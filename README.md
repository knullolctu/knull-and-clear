# Kokoro TTS Web App

Browser text-to-speech powered by **[Kokoro](https://github.com/hexgrad/kokoro)** (82M) via [`kokoro-js`](https://www.npmjs.com/package/kokoro-js).

You can:

1. Load the model from **Hugging Face** (default for quick local dev), or  
2. **Self-host the model on GitHub** next to the app (recommended for your own site)

---

## Quick start (dev)

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Without a local model, weights download from Hugging Face on first load.

---

## Self-host the model on GitHub

### 1. Download model files into the repo

```bash
# ~90MB quantized (q8) + voices + tokenizer  — good default for GitHub
npm run download-model

# English voices only (smaller)
npm run download-model:english

# Also grab full-precision (~325MB extra, needs Git LFS)
npm run download-model:fp32
```

This creates:

```
public/models/onnx-community/Kokoro-82M-v1.0-ONNX/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_quantized.onnx    # q8
  onnx/model.onnx              # only with --fp32
  voices/*.bin
```

Vite copies everything under `public/` into the build output, so GitHub Pages serves the model from:

`https://YOUR_USER.github.io/YOUR_REPO/models/onnx-community/Kokoro-82M-v1.0-ONNX/`

### 2. Track large files with Git LFS

ONNX weights are ~90MB+ (GitHub blocks files over **100MB** without LFS).

```bash
# once per machine
git lfs install

# .gitattributes already tracks *.onnx and *.bin
git add .gitattributes
git add public/models
git commit -m "Add self-hosted Kokoro model"
```

> **Bandwidth note:** Free GitHub LFS includes limited monthly bandwidth. Every visitor who loads the model counts against it. For a busy public site, consider [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github) + a CDN, or Cloudflare R2 / similar object storage.

### 3. Enable GitHub Pages

1. Push the repo to GitHub  
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**  
3. The workflow in `.github/workflows/deploy.yml` builds and deploys on push to `main`/`master`

Site URL:

- Project site: `https://YOUR_USER.github.io/YOUR_REPO/`  
- User site (`YOUR_USER.github.io` repo): `https://YOUR_USER.github.io/`

The workflow sets Vite `base` automatically for project pages.

### 4. Manual build (optional)

```bash
# project pages
set VITE_BASE=/YOUR_REPO/   # Windows PowerShell: $env:VITE_BASE="/YOUR_REPO/"
npm run build
```

---

## How self-hosting works

| Component | Source |
| --- | --- |
| ONNX weights + tokenizer | `public/models/...` (your GitHub Pages URL) |
| Voice style vectors (`.bin`) | Same folder; worker rewrites HF voice URLs → local paths |
| App JS/CSS | Built by Vite → Pages |

The worker configures Transformers.js like this:

```js
env.allowLocalModels = true;
env.localModelPath = `${BASE_URL}models/`;
```

If local files are missing, it can still fall back to Hugging Face for easier development.

---

## Features

- Multi-voice TTS (American & British English)
- WebGPU when available, WASM otherwise
- Adjustable speed, audio history, WAV download
- Optional fully self-hosted model (no HF at runtime)

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview production build |
| `npm run download-model` | Fetch q8 + all voices into `public/models` |
| `npm run download-model:english` | Smaller voice set |
| `npm run download-model:fp32` | q8 + full precision weights |

## License

App code: free to use.  
Kokoro / `kokoro-js`: Apache-2.0.
