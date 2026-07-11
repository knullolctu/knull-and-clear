/**
 * Save downloaded TTS model files into a GitHub repository
 * under public/models/{modelId}/… via the Git Data API (one commit).
 *
 * Requires a personal access token with Contents: Read and write
 * (classic: `repo` scope) stored only in this browser's localStorage.
 */

import {
  filesForModelEntry,
  getModelEntry,
} from "./modelCatalog.js";

const STORAGE_KEY = "knullclear.githubModels";

/** GitHub Contents / Blobs API hard limit is 100 MB. */
export const GITHUB_MAX_FILE_BYTES = 99 * 1024 * 1024;

/** @typedef {{ enabled: boolean, owner: string, repo: string, branch: string, token: string }} GithubModelsConfig */

/** @returns {GithubModelsConfig} */
export function loadGithubModelsConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      owner: String(parsed.owner || "knullolctu").trim() || "knullolctu",
      repo: String(parsed.repo || "knull-and-clear").trim() || "knull-and-clear",
      branch: String(parsed.branch || "master").trim() || "master",
      token: String(parsed.token || ""),
    };
  } catch {
    return defaultConfig();
  }
}

/** @returns {GithubModelsConfig} */
function defaultConfig() {
  return {
    // On by default: Download commits models to the GitHub repo (needs a token once).
    enabled: true,
    owner: "knullolctu",
    repo: "knull-and-clear",
    branch: "master",
    token: "",
  };
}

/**
 * Trigger the "Add model to repo" GitHub Action.
 * CI downloads from Hugging Face and commits under public/models/ (no big browser upload).
 *
 * Token needs classic scopes: `repo` + `workflow` (or fine-grained: Actions write + Contents write).
 *
 * @param {GithubModelsConfig} config
 * @param {string} modelKey
 * @param {(ev: object) => void} [onProgress]
 */
export async function triggerAddModelWorkflow(config, modelKey, onProgress) {
  if (!isGithubSaveReady(config)) {
    throw new Error(
      "Enable “Save downloads to GitHub” and paste a GitHub token first.",
    );
  }
  const entry = getModelEntry(modelKey);
  const { owner, repo, branch } = config;

  onProgress?.({
    type: "start",
    message: `Starting GitHub Action to save ${entry.shortLabel} into ${owner}/${repo}…`,
  });

  // Prefer workflow file path; fall back to workflow id lookup if needed.
  const dispatchPath = `/repos/${owner}/${repo}/actions/workflows/add-model.yml/dispatches`;
  try {
    await ghApi(config, dispatchPath, {
      method: "POST",
      body: JSON.stringify({
        ref: branch,
        inputs: { model_key: modelKey },
      }),
    });
  } catch (err) {
    // 404 sometimes means wrong path — try listing workflows
    if (err?.status === 404) {
      const list = await ghApi(config, `/repos/${owner}/${repo}/actions/workflows`);
      const wf = (list.workflows || []).find(
        (w) =>
          w.path?.endsWith("add-model.yml") ||
          w.name === "Add model to repo",
      );
      if (!wf) throw err;
      await ghApi(
        config,
        `/repos/${owner}/${repo}/actions/workflows/${wf.id}/dispatches`,
        {
          method: "POST",
          body: JSON.stringify({
            ref: branch,
            inputs: { model_key: modelKey },
          }),
        },
      );
    } else {
      throw err;
    }
  }

  const actionsUrl = `https://github.com/${owner}/${repo}/actions/workflows/add-model.yml`;
  onProgress?.({
    type: "complete",
    message: `GitHub Action started — it will commit ${entry.shortLabel} to the repo, then Pages redeploys.`,
  });

  return {
    mode: "workflow",
    modelKey,
    actionsUrl,
    htmlUrl: actionsUrl,
  };
}

/** @param {Partial<GithubModelsConfig>} partial */
export function saveGithubModelsConfig(partial) {
  const next = { ...loadGithubModelsConfig(), ...partial };
  next.owner = String(next.owner || "").trim() || "knullolctu";
  next.repo = String(next.repo || "").trim() || "knull-and-clear";
  next.branch = String(next.branch || "").trim() || "master";
  next.token = String(next.token || "");
  next.enabled = Boolean(next.enabled);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function isGithubSaveReady(config = loadGithubModelsConfig()) {
  return Boolean(
    config.enabled &&
      config.token &&
      config.owner &&
      config.repo &&
      config.branch,
  );
}

/**
 * @param {ArrayBuffer | Uint8Array} data
 */
export function arrayBufferToBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {GithubModelsConfig} config
 * @param {string} path API path e.g. /repos/o/r/git/ref/heads/master
 * @param {RequestInit} [opts]
 */
async function ghApi(config, path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    const msg =
      json?.message ||
      `GitHub API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Upload pre-fetched model files into public/models/{modelId}/…
 * @param {object} opts
 * @param {GithubModelsConfig} opts.config
 * @param {string} opts.modelKey catalog key
 * @param {{ path: string, data: ArrayBuffer }[]} opts.files relative paths under modelId
 * @param {(ev: object) => void} [opts.onProgress]
 */
export async function uploadModelFilesToRepo({
  config,
  modelKey,
  files,
  onProgress,
}) {
  if (!isGithubSaveReady(config)) {
    throw new Error(
      "Enable “Save downloads to GitHub” and paste a repo token first.",
    );
  }

  const entry = getModelEntry(modelKey);
  const modelId = entry.modelId;
  const { owner, repo, branch } = config;

  const usable = [];
  const skipped = [];
  for (const f of files) {
    const size = f.data?.byteLength ?? 0;
    if (size <= 0) continue;
    if (size > GITHUB_MAX_FILE_BYTES) {
      skipped.push({
        path: f.path,
        size,
        reason: `over ${Math.round(GITHUB_MAX_FILE_BYTES / 1024 / 1024)} MB (GitHub API limit)`,
      });
      continue;
    }
    usable.push(f);
  }

  if (usable.length === 0) {
    throw new Error(
      skipped.length
        ? `No files small enough for GitHub API (limit ~100 MB). Skipped: ${skipped.map((s) => s.path).join(", ")}`
        : "No files to upload.",
    );
  }

  onProgress?.({
    type: "start",
    message: `Uploading ${usable.length} file(s) to ${owner}/${repo}@${branch}…`,
  });

  const ref = await ghApi(
    config,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const headSha = ref.object.sha;
  const headCommit = await ghApi(
    config,
    `/repos/${owner}/${repo}/git/commits/${headSha}`,
  );
  const baseTreeSha = headCommit.tree.sha;

  /** @type {{ path: string, mode: string, type: string, sha: string }[]} */
  const tree = [];

  for (let i = 0; i < usable.length; i++) {
    const f = usable[i];
    const repoPath = `public/models/${modelId}/${f.path}`.replace(/\\/g, "/");
    onProgress?.({
      type: "progress",
      file: f.path,
      index: i + 1,
      count: usable.length,
      message: `GitHub blob ${i + 1}/${usable.length}: ${f.path}`,
    });

    const blob = await ghApi(config, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: arrayBufferToBase64(f.data),
        encoding: "base64",
      }),
    });

    tree.push({
      path: repoPath,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  onProgress?.({
    type: "progress",
    message: "Creating commit tree…",
  });

  const newTree = await ghApi(config, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree,
    }),
  });

  const message = [
    `Add model ${entry.shortLabel} (${modelId})`,
    "",
    `Uploaded ${usable.length} file(s) from Knull & Clear download.`,
    skipped.length
      ? `Skipped (too large for API): ${skipped.map((s) => s.path).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const newCommit = await ghApi(config, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });

  await ghApi(
    config,
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha }),
    },
  );

  onProgress?.({
    type: "complete",
    message: `Saved to GitHub ${owner}/${repo} (${usable.length} files). Pages will redeploy.`,
    commitSha: newCommit.sha,
    skipped,
  });

  return {
    commitSha: newCommit.sha,
    uploaded: usable.map((f) => f.path),
    skipped,
    htmlUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
  };
}

/**
 * Download model files from Hugging Face and commit them to the repo.
 * @param {string} modelKey
 * @param {GithubModelsConfig} config
 * @param {(ev: object) => void} [onProgress]
 */
export async function downloadEntryToGithubRepo(modelKey, config, onProgress) {
  const entry = getModelEntry(modelKey);
  const files = filesForModelEntry(entry);
  const modelId = entry.modelId;
  /** @type {{ path: string, data: ArrayBuffer }[]} */
  const fetched = [];

  onProgress?.({
    type: "start",
    message: `Downloading ${entry.shortLabel} for GitHub (${files.length} files)…`,
  });

  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const url = `https://huggingface.co/${modelId}/resolve/main/${rel}`;
    onProgress?.({
      type: "start",
      file: rel,
      index: i + 1,
      count: files.length,
      message: `Downloading ${rel}…`,
    });

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed ${rel}: HTTP ${res.status}`);
    }

    const total = Number(res.headers.get("content-length")) || 0;
    let data;
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
      data = concatChunks(chunks);
    } else {
      data = await res.arrayBuffer();
    }

    fetched.push({ path: rel, data });
    onProgress?.({
      type: "file-done",
      file: rel,
      loaded: data.byteLength,
      total: data.byteLength,
      message: `Fetched ${rel}`,
    });
  }

  return uploadModelFilesToRepo({
    config,
    modelKey,
    files: fetched,
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
