import fs from "fs";
import path from "path";
import simpleGit from "simple-git";

export interface FetchRepoParams {
  indexingJobId: string;
  htmlUrl: string;
  defaultBranch?: string;
  isPrivate?: boolean;
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
  if (params.isPrivate) {
    throw new Error(
      "Private repositories are not supported in Phase 1 ingestion. GitHub access tokens are not persisted to database storage for security."
    );
  }

  const baseTmpDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(baseTmpDir)) {
    await fs.promises.mkdir(baseTmpDir, { recursive: true });
  }

  const workspacePath = path.join(baseTmpDir, `workspace-${params.indexingJobId}`);

  if (fs.existsSync(workspacePath)) {
    await fs.promises.rm(workspacePath, { recursive: true, force: true });
  }

  const git = simpleGit();
  const cloneArgs = ["--depth", "1"];
  if (params.defaultBranch) {
    cloneArgs.push("--branch", params.defaultBranch);
  }

  await git.clone(params.htmlUrl, workspacePath, cloneArgs);

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
    await fs.promises.rm(workspacePath, { recursive: true, force: true });
  }
}
