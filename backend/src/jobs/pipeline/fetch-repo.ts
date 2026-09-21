import fs from "fs";
import path from "path";
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

export async function fetchRepo(params: FetchRepoParams): Promise<FetchRepoResult> {
  const baseTmpDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(baseTmpDir)) {
    await fs.promises.mkdir(baseTmpDir, { recursive: true });
  }

  const workspacePath = path.join(baseTmpDir, `workspace-${params.indexingJobId}`);

  if (fs.existsSync(workspacePath)) {
    try {
      await fs.promises.rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    } catch {
      // Ignore transient cleanup errors before clone
    }
  }

  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Force HTTP/1.1 to avoid HTTP/2 stream closure errors on Windows
    GIT_HTTP_VERSION: "HTTP/1.1",
  };

  const git = simpleGit({
    env: gitEnv,
    timeout: { block: 600_000 }, // 10 minutes timeout for large repos (100MB+)
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

  if (params.isPrivate && !params.accessToken) {
    throw new Error(`Cannot clone private repository '${params.htmlUrl}' without an authentication access token. Please connect a public repository or configure a GitHub App installation.`);
  }

  let cloneUrl = params.htmlUrl;
  if (params.accessToken && cloneUrl.startsWith("https://")) {
    cloneUrl = cloneUrl.replace("https://", `https://x-access-token:${params.accessToken}@`);
  }

  // Retry clone up to 3 times to handle transient HTTP/2 stream errors
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Clean up any partial clone from a previous failed attempt
      if (attempt > 1 && fs.existsSync(workspacePath)) {
        try {
          await fs.promises.rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
        } catch {
          // Ignore transient error
        }
      }
      await git.clone(cloneUrl, workspacePath, cloneArgs);
      break; // Success
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
        errMsg.includes("block timeout");

      if (isTransient && attempt < maxRetries) {
        const delay = 3000 * attempt; // 3s, 6s
        console.warn(
          `[fetch-repo] Clone attempt ${attempt}/${maxRetries} failed (transient HTTP error), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }

  const gitWorkspace = simpleGit(workspacePath);
  let commitSha = "unknown";
  try {
    commitSha = (await gitWorkspace.revparse(["HEAD"])).trim();
  } catch {
    commitSha = "unknown";
  }

  const files: FetchedFile[] = [];

  async function walkDir(currentDir: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(workspacePath, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await walkDir(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (EXCLUDED_EXACT_FILENAMES.has(entry.name)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (
        EXCLUDED_EXTENSIONS.has(ext) ||
        relativePath.endsWith(".min.js") ||
        relativePath.endsWith(".min.css")
      ) {
        continue;
      }

      const stats = await fs.promises.stat(fullPath);
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      files.push({
        relativePath,
        absolutePath: fullPath,
        extension: ext,
        sizeBytes: stats.size,
      });
    }
  }

  await walkDir(workspacePath);

  return {
    workspacePath,
    commitSha,
    files,
  };
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
    const rawDiff = await git.raw([
      "diff",
      "--name-status",
      lastCommitSha,
      newCommitSha,
    ]);

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

