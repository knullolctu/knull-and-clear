import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import {
  downloadModelPlan,
  onnxRelPath,
  planFilesForEntry,
} from "./scripts/lib/download-model-files.mjs";
import { MODEL_CATALOG, getModelEntry } from "./src/modelCatalog.js";

// GitHub Pages project sites need base: "/repo-name/"
// Set via: VITE_BASE=/my-repo/ npm run build
// The deploy workflow sets this automatically.
const base = process.env.VITE_BASE || "/";

/**
 * Model asset middleware:
 * 1) 404 missing .onnx/.bin (no SPA HTML fallback)
 * 2) Mark assets as inline so the browser does not treat fetch/open as a
 *    "Save to Downloads" for application/octet-stream voice packs
 */
function modelAssetsMiddleware() {
  const modelAsset = (url) => {
    const raw = (url || "").split("?")[0];
    return raw.includes("/models/") && /\.(onnx|bin)$/i.test(raw);
  };

  const resolvePath = (root, publicFolder, reqUrl) => {
    let pathname = decodeURIComponent((reqUrl || "").split("?")[0]);
    if (base !== "/" && pathname.startsWith(base)) {
      pathname = pathname.slice(base.length - 1);
    }
    const rel = pathname.replace(/^\/+/, "");
    return path.join(root, publicFolder, rel);
  };

  const attachInlineHeaders = (req, res) => {
    if (!modelAsset(req.url || "")) return;
    res.setHeader("Content-Disposition", "inline");
    if (/\.bin$/i.test((req.url || "").split("?")[0])) {
      res.setHeader("Content-Type", "application/octet-stream");
    } else if (/\.onnx$/i.test((req.url || "").split("?")[0])) {
      res.setHeader("Content-Type", "application/octet-stream");
    }
  };

  const guardMissing = (root, publicFolder) => (req, res, next) => {
    if (!modelAsset(req.url || "")) return next();

    attachInlineHeaders(req, res);

    const filePath = resolvePath(root, publicFolder, req.url);
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Not found");
      return;
    }
    next();
  };

  return {
    name: "model-assets-middleware",
    configureServer(server) {
      server.middlewares.use(guardMissing(server.config.root, "public"));
    },
    configurePreviewServer(server) {
      server.middlewares.use(guardMissing(server.config.root, "dist"));
    },
  };
}

/**
 * Dev API: download catalog models into public/models with SSE progress.
 * GET /api/download-model?key=kokoro-v1-quality
 */
function modelDownloadApi() {
  let busy = false;

  const send = (res, obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  return {
    name: "model-download-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || "";
        const urlPath = rawUrl.split("?")[0];
        if (urlPath !== "/api/download-model") return next();

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Use GET" }));
          return;
        }

        const qs = new URL(rawUrl, "http://localhost").searchParams;
        const key = qs.get("key") || "";
        const entry = MODEL_CATALOG.find((m) => m.key === key);

        if (!entry) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `Unknown model key: ${key}`,
              known: MODEL_CATALOG.map((m) => m.key),
            }),
          );
          return;
        }

        if (busy) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ error: "Another download is already running." }),
          );
          return;
        }

        busy = true;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        // COEP-friendly
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

        const plan = planFilesForEntry(entry, { includeVoices: true });
        // Ensure primary weight file is first after configs for snappy UI feedback
        plan.files.sort((a, b) => {
          const score = (f) =>
            f.startsWith("onnx/") ? 0 : f.startsWith("voices/") ? 2 : 1;
          return score(a) - score(b);
        });

        try {
          send(res, {
            type: "start",
            key: entry.key,
            modelId: entry.modelId,
            label: entry.shortLabel,
            files: plan.files,
            primaryFile: onnxRelPath(entry.dtype),
            message: `Downloading ${entry.shortLabel}…`,
          });

          await downloadModelPlan(plan, (ev) => {
            send(res, { key: entry.key, ...ev });
          });

          send(res, {
            type: "complete",
            key: entry.key,
            message: `${entry.shortLabel} is ready on disk.`,
          });
        } catch (err) {
          send(res, {
            type: "error",
            key: entry.key,
            message: err?.message || String(err),
          });
        } finally {
          busy = false;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  base,
  publicDir: "public",
  plugins: [modelAssetsMiddleware(), modelDownloadApi()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["kokoro-js"],
  },
  worker: {
    format: "es",
  },
});
