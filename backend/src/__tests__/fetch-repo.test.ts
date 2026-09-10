import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  fetchRepo,
  cleanupRepo,
  MAX_FILE_SIZE_BYTES,
  EXCLUDED_DIRECTORIES,
  EXCLUDED_EXTENSIONS,
  EXCLUDED_EXACT_FILENAMES,
} from "../jobs/pipeline/fetch-repo";


vi.mock("simple-git", () => {
  const mockClone = vi.fn().mockImplementation(async (_url: string, targetPath: string) => {
    // Create mock directory structure in targetPath for testing
    await fs.promises.mkdir(path.join(targetPath, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(targetPath, "node_modules", "package"), { recursive: true });
    await fs.promises.mkdir(path.join(targetPath, ".git"), { recursive: true });
    await fs.promises.mkdir(path.join(targetPath, "dist"), { recursive: true });

    // Valid code files
    await fs.promises.writeFile(path.join(targetPath, "src", "index.ts"), "console.log('hello');");
    await fs.promises.writeFile(path.join(targetPath, "src", "app.js"), "const x = 1;");
    await fs.promises.writeFile(path.join(targetPath, "README.md"), "# Mock Repo");

    // Excluded files
    await fs.promises.writeFile(path.join(targetPath, "node_modules", "package", "index.js"), "module.exports = {};");
    await fs.promises.writeFile(path.join(targetPath, ".git", "config"), "[core]");
    await fs.promises.writeFile(path.join(targetPath, "dist", "bundle.js"), "var bundle = {};");
    await fs.promises.writeFile(path.join(targetPath, "package-lock.json"), "{}");
    await fs.promises.writeFile(path.join(targetPath, "logo.png"), "FAKE_PNG_BINARY");
    await fs.promises.writeFile(path.join(targetPath, "bundle.min.js"), "var a=1;");

    // Large file exceeding MAX_FILE_SIZE_BYTES
    const largeBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 100);
    await fs.promises.writeFile(path.join(targetPath, "large-file.txt"), largeBuffer);
  });

  const mockRevparse = vi.fn().mockResolvedValue("abc123def456789");

  const mockGitInstance = {
    clone: mockClone,
    revparse: mockRevparse,
  };

  return {
    default: vi.fn(() => mockGitInstance),
  };
});

describe("Pipeline Stage 1: fetchRepo (RFC 0005 & RFC 0010)", () => {
  const testJobId = "test-job-999";
  let createdWorkspace = "";

  afterEach(async () => {
    if (createdWorkspace) {
      await cleanupRepo(createdWorkspace);
    }
  });

  it("should shallow clone private repo with authenticated URL when accessToken is provided (RFC 0021)", async () => {
    const result = await fetchRepo({
      indexingJobId: testJobId,
      htmlUrl: "https://github.com/octocat/private-repo",
      isPrivate: true,
      accessToken: "ghs_test_token_123",
    });

    createdWorkspace = result.workspacePath;
    expect(result.workspacePath).toContain(`workspace-${testJobId}`);
    expect(result.commitSha).toBe("abc123def456789");
  });

  it("should shallow clone public repo and filter out excluded files and directories", async () => {
    const result = await fetchRepo({
      indexingJobId: testJobId,
      htmlUrl: "https://github.com/octocat/public-repo",
      defaultBranch: "main",
      isPrivate: false,
    });

    createdWorkspace = result.workspacePath;

    expect(result.workspacePath).toContain(`workspace-${testJobId}`);
    expect(result.commitSha).toBe("abc123def456789");

    const relativePaths = result.files.map((f) => f.relativePath);

    // Should include valid code files
    expect(relativePaths).toContain("src/index.ts");
    expect(relativePaths).toContain("src/app.js");
    expect(relativePaths).toContain("README.md");

    // Should exclude node_modules, .git, dist, package-lock.json, binary .png, .min.js, and large files
    expect(relativePaths).not.toContain("node_modules/package/index.js");
    expect(relativePaths).not.toContain(".git/config");
    expect(relativePaths).not.toContain("dist/bundle.js");
    expect(relativePaths).not.toContain("package-lock.json");
    expect(relativePaths).not.toContain("logo.png");
    expect(relativePaths).not.toContain("bundle.min.js");
    expect(relativePaths).not.toContain("large-file.txt");
  });

  it("should cleanly remove workspace directory when cleanupRepo is called", async () => {
    const result = await fetchRepo({
      indexingJobId: testJobId,
      htmlUrl: "https://github.com/octocat/public-repo",
      isPrivate: false,
    });

    createdWorkspace = result.workspacePath;
    expect(fs.existsSync(createdWorkspace)).toBe(true);

    await cleanupRepo(createdWorkspace);
    expect(fs.existsSync(createdWorkspace)).toBe(false);
  });

  it("should export correct filter constants", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(524_288);
    expect(EXCLUDED_DIRECTORIES.has("node_modules")).toBe(true);
    expect(EXCLUDED_DIRECTORIES.has(".git")).toBe(true);
    expect(EXCLUDED_EXTENSIONS.has(".png")).toBe(true);
    expect(EXCLUDED_EXACT_FILENAMES.has("package-lock.json")).toBe(true);
  });
});
