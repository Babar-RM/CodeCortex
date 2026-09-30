import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Readable } from "stream";
import simpleGit from "simple-git";

export interface FetchRepoParams {
  indexingJobId: string;
  htmlUrl: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  installationId?: string;
  accessToken?: string;
}

export interface FetchedFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  sizeBytes: number;
}

export interface FetchRepoResult {
  workspacePath: string;
  commitSha: string;
  files: FetchedFile[];
}

export const MAX_FILE_SIZE_BYTES = 524_288; // 500 KB limit per file

export const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".idea",
  ".vscode",
  "coverage",
]);

export const EXCLUDED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".mp4",
  ".mp3",
  ".wav",
  ".avi",
  ".mov",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".bin",
  ".pyc",
  ".pyo",
  ".pyd",
  ".db",
  ".sqlite",
  ".ttf",
  ".woff",
  ".woff2",
  ".eot",
]);

export const EXCLUDED_EXACT_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
]);

// ---------------------------------------------------------------------------
// File system walker — shared by all acquisition strategies
// ---------------------------------------------------------------------------
async function walkDir(workspacePath: string, currentDir: string, files: FetchedFile[]): Promise<void> {
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(workspacePath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await walkDir(workspacePath, fullPath, files);
      }
      continue;
    }

    if (!entry.isFile()) continue;
    if (EXCLUDED_EXACT_FILENAMES.has(entry.name)) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (
      EXCLUDED_EXTENSIONS.has(ext) ||
      relativePath.endsWith(".min.js") ||
      relativePath.endsWith(".min.css")
    ) {
      continue;
    }

    const stats = await fs.promises.stat(fullPath);
    if (stats.size > MAX_FILE_SIZE_BYTES) continue;

    files.push({ relativePath, absolutePath: fullPath, extension: ext, sizeBytes: stats.size });
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: GitHub Tarball Archive Download (fastest, no git required)
// ---------------------------------------------------------------------------
async function fetchViaTarball(params: {
  htmlUrl: string;
  defaultBranch: string;
  workspacePath: string;
  accessToken?: string;
}): Promise<string> {
  // Convert https://github.com/owner/repo → owner/repo
  const repoPath = params.htmlUrl.replace("https://github.com/", "").replace(/\.git$/, "");
  const branch = params.defaultBranch || "main";
  const tarballUrl = `https://api.github.com/repos/${repoPath}/tarball/${branch}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CodeCortex-Ingestion/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (params.accessToken) {
    headers["Authorization"] = `Bearer ${params.accessToken}`;
  }

  console.log(`[fetch-repo] Strategy 1: Downloading tarball from ${tarballUrl}`);
  const response = await fetch(tarballUrl, { headers, redirect: "follow" });

  if (!response.ok) {
    throw new Error(`Tarball download failed: HTTP ${response.status} from GitHub API`);
  }

  if (!response.body) {
    throw new Error("Tarball download returned empty body");
  }

  await fs.promises.mkdir(params.workspacePath, { recursive: true });

  // Dynamically import tar to avoid startup overhead
  const tar = await import("tar");

  // Stream decompress and extract
  const gunzip = zlib.createGunzip();
  const nodeStream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);

  let topLevelDir = "";

  await new Promise<void>((resolve, reject) => {
    const extractor = tar.extract({
      cwd: params.workspacePath,
      strip: 1, // GitHub tarballs have a top-level directory like owner-repo-sha/
      filter: (entryPath: string) => {
        // Capture the top-level dir for SHA extraction
        if (!topLevelDir && entryPath.includes("/")) {
          topLevelDir = entryPath.split("/")[0];
        }
        const parts = entryPath.split("/").slice(1); // Strip top-level dir
        // Filter excluded directories early during extraction
        return !parts.some((p) => EXCLUDED_DIRECTORIES.has(p));
      },
      onentry: (entry: { path: string }) => {
        if (!topLevelDir && entry.path.includes("/")) {
          topLevelDir = entry.path.split("/")[0];
        }
      },
    });

    nodeStream.pipe(gunzip).pipe(extractor);
    extractor.on("finish", resolve);
    extractor.on("error", reject);
    gunzip.on("error", reject);
    nodeStream.on("error", reject);
  });

  // Extract commit SHA from the top-level directory name (format: owner-repo-<sha7>)
  // GitHub tarball dirs are like: Babar-RM-Islamic-Knowledge-assistant-abc1234
  const sha = topLevelDir ? topLevelDir.split("-").pop() || "unknown" : "unknown";
  console.log(`[fetch-repo] Tarball extracted. Detected SHA prefix: ${sha}`);

  // Try to get full SHA via GitHub API
  try {
    const commitApiUrl = `https://api.github.com/repos/${repoPath}/commits/${branch}`;
    const commitRes = await fetch(commitApiUrl, { headers });
    if (commitRes.ok) {
      const commitData = (await commitRes.json()) as { sha?: string };
      if (commitData.sha) {
        console.log(`[fetch-repo] Resolved full commit SHA: ${commitData.sha}`);
        return commitData.sha;
      }
    }
  } catch {
    // Non-fatal — return the short SHA from the tarball dir name
  }

  return sha;
}

// ---------------------------------------------------------------------------
// Strategy 2: Git clone --filter=blob:none (blobless fetch)
// ---------------------------------------------------------------------------
async function fetchViaBloblessClone(params: {
  cloneUrl: string;
  defaultBranch: string;
  workspacePath: string;
}): Promise<string> {
  // Pass git env overrides via the baseDir + options two-argument form
  const git = simpleGit(undefined as unknown as string, {
    config: ["http.version=HTTP/1.1"],
    timeout: { block: 120_000 },
  });
  process.env["GIT_TERMINAL_PROMPT"] = "0";
  process.env["GIT_HTTP_VERSION"] = "HTTP/1.1";

  const cloneArgs = [
    "--depth", "1",
    "--filter=blob:none",
    "--single-branch",
    "-c", "http.postBuffer=524288000",
    "-c", "http.version=HTTP/1.1",
  ];
  if (params.defaultBranch) {
    cloneArgs.push("--branch", params.defaultBranch);
  }

  console.log(`[fetch-repo] Strategy 2: Blobless git clone for ${params.cloneUrl}`);
  await git.clone(params.cloneUrl, params.workspacePath, cloneArgs);

  const gitWorkspace = simpleGit(params.workspacePath);
  const sha = (await gitWorkspace.revparse(["HEAD"])).trim();
  return sha;
}

// ---------------------------------------------------------------------------
// Strategy 3: Standard shallow clone (final fallback)
// ---------------------------------------------------------------------------
async function fetchViaShallowClone(params: {
  cloneUrl: string;
  defaultBranch: string;
  workspacePath: string;
}): Promise<string> {
  process.env["GIT_TERMINAL_PROMPT"] = "0";
  process.env["GIT_HTTP_VERSION"] = "HTTP/1.1";
  const git = simpleGit(undefined as unknown as string, {
    config: ["http.version=HTTP/1.1", "core.compression=0"],
    timeout: { block: 600_000 },
  });

  const cloneArgs = [
    "--depth", "1",
    "--single-branch",
    "-c", "http.postBuffer=1048576000",
    "-c", "http.version=HTTP/1.1",
    "-c", "core.compression=0",
  ];
  if (params.defaultBranch) {
    cloneArgs.push("--branch", params.defaultBranch);
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1 && fs.existsSync(params.workspacePath)) {
        await fs.promises.rm(params.workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
      }
      console.log(`[fetch-repo] Strategy 3: Shallow clone attempt ${attempt}/${maxRetries}`);
      await git.clone(params.cloneUrl, params.workspacePath, cloneArgs);
      break;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTransient =
        errMsg.includes("HTTP/2 stream") ||
        errMsg.includes("RPC failed") ||
        errMsg.includes("curl 92") ||
        errMsg.includes("curl 56") ||
        errMsg.includes("early EOF") ||
        errMsg.includes("unexpected disconnect") ||
        errMsg.includes("fetch-pack") ||
        errMsg.includes("timeout") ||
        errMsg.includes("block timeout") ||
        errMsg.includes("index-pack");

      if (isTransient && attempt < maxRetries) {
        const delay = 5000 * attempt;
        console.warn(`[fetch-repo] Transient error on attempt ${attempt}, retrying in ${delay}ms: ${errMsg.substring(0, 100)}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  const gitWorkspace = simpleGit(params.workspacePath);
  let sha = "unknown";
  try {
    sha = (await gitWorkspace.revparse(["HEAD"])).trim();
  } catch {
    sha = "unknown";
  }
  return sha;
}

// ---------------------------------------------------------------------------
// Main entrypoint — orchestrates the three-tier fallback strategy
// ---------------------------------------------------------------------------
export async function fetchRepo(params: FetchRepoParams): Promise<FetchRepoResult> {
  const baseTmpDir = path.join(process.cwd(), "tmp");
  await fs.promises.mkdir(baseTmpDir, { recursive: true });

  const workspacePath = path.join(baseTmpDir, `workspace-${params.indexingJobId}`);

  // Clean up any previous partial workspace
  if (fs.existsSync(workspacePath)) {
    try {
      await fs.promises.rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    } catch {
      // Ignore transient cleanup errors
    }
  }

  if (params.isPrivate && !params.accessToken) {
    throw new Error(
      `Cannot clone private repository '${params.htmlUrl}' without an authentication access token. ` +
      `Please connect a public repository or configure a GitHub App installation.`
    );
  }

  let cloneUrl = params.htmlUrl;
  if (params.accessToken && cloneUrl.startsWith("https://")) {
    cloneUrl = cloneUrl.replace("https://", `https://x-access-token:${params.accessToken}@`);
  }

  const branch = params.defaultBranch || "main";
  let commitSha = "unknown";
  let strategyUsed = "unknown";

  // ---- Strategy 1: Tarball (public repos only, fastest) -------------------
  if (!params.isPrivate) {
    try {
      commitSha = await fetchViaTarball({
        htmlUrl: params.htmlUrl,
        defaultBranch: branch,
        workspacePath,
        accessToken: params.accessToken,
      });
      strategyUsed = "tarball";
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[fetch-repo] Tarball strategy failed (${errMsg.substring(0, 120)}), falling back to blobless clone...`);
      // Clean up any partial extraction
      if (fs.existsSync(workspacePath)) {
        try { await fs.promises.rm(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  // ---- Strategy 2: Blobless clone (if tarball failed or private) ----------
  if (strategyUsed === "unknown") {
    try {
      commitSha = await fetchViaBloblessClone({
        cloneUrl,
        defaultBranch: branch,
        workspacePath,
      });
      strategyUsed = "blobless-clone";
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[fetch-repo] Blobless clone failed (${errMsg.substring(0, 120)}), falling back to shallow clone...`);
      if (fs.existsSync(workspacePath)) {
        try { await fs.promises.rm(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  // ---- Strategy 3: Standard shallow clone (last resort) ------------------
  if (strategyUsed === "unknown") {
    commitSha = await fetchViaShallowClone({
      cloneUrl,
      defaultBranch: branch,
      workspacePath,
    });
    strategyUsed = "shallow-clone";
  }

  console.log(`[fetch-repo] Acquisition complete via [${strategyUsed}]. SHA: ${commitSha}. Walking files...`);

  const files: FetchedFile[] = [];
  await walkDir(workspacePath, workspacePath, files);

  console.log(`[fetch-repo] Filtered file count: ${files.length}`);

  return { workspacePath, commitSha, files };
}

export async function cleanupRepo(workspacePath: string): Promise<void> {
  if (workspacePath && fs.existsSync(workspacePath)) {
    try {
      await fs.promises.rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    } catch (e) {
      console.warn(`[fetch-repo] Warning cleaning up ${workspacePath}:`, e);
    }
  }
}

export interface FileDiffResult {
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
}

export async function computeFileDiff(
  workspacePath: string,
  lastCommitSha: string,
  newCommitSha: string
): Promise<FileDiffResult> {
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  try {
    const git = simpleGit(workspacePath);
    const rawDiff = await git.raw(["diff", "--name-status", lastCommitSha, newCommitSha]);

    const lines = rawDiff.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const status = parts[0];
        const filePath = parts[1].replace(/\\/g, "/");

        if (status.startsWith("A")) {
          addedFiles.push(filePath);
        } else if (status.startsWith("M")) {
          modifiedFiles.push(filePath);
        } else if (status.startsWith("D")) {
          deletedFiles.push(filePath);
        } else if (status.startsWith("R")) {
          const newFilePath = parts[2] ? parts[2].replace(/\\/g, "/") : filePath;
          deletedFiles.push(filePath);
          addedFiles.push(newFilePath);
        }
      }
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Git diff failed";
    console.warn(`[fetch-repo] Git diff failed between ${lastCommitSha} and ${newCommitSha}: ${errorMsg}`);
  }

  return { addedFiles, modifiedFiles, deletedFiles };
}
