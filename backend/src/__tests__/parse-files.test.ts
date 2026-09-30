import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parseFiles, detectLanguage } from "../jobs/pipeline/parse-files";
import * as parserClient from "../lib/parser-client";

describe("Pipeline Stage 2: parseFiles (RFC 0006)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs) {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("should correctly detect file languages by extension", () => {
    expect(detectLanguage("app.ts")).toBe("typescript");
    expect(detectLanguage("component.tsx")).toBe("typescript");
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("script.mjs")).toBe("javascript");
  });

  it("should read files, invoke parserClient, and return aggregated symbol facts", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "parse-test-"));
    tmpDirs.push(tmpDir);

    const file1Path = path.join(tmpDir, "index.ts");
    const file2Path = path.join(tmpDir, "app.js");

    await fs.promises.writeFile(file1Path, "function main() {}");
    await fs.promises.writeFile(file2Path, "class App {}");

    vi.spyOn(parserClient, "parseFileWithService").mockImplementation(async (payload) => {
      if (payload.filePath === "index.ts") {
        return {
          filePath: "index.ts",
          language: "typescript",
          functions: [{ name: "main", startLine: 1, endLine: 1, params: [] }],
          classes: [],
          imports: [],
          calls: [],
          error: null,
        };
      }
      return {
        filePath: "app.js",
        language: "javascript",
        functions: [],
        classes: [{ name: "App", startLine: 1, endLine: 1, heritage: [] }],
        imports: [],
        calls: [],
        error: null,
      };
    });

    const mockFiles = [
      { relativePath: "index.ts", absolutePath: file1Path, extension: ".ts", sizeBytes: 20 },
      { relativePath: "app.js", absolutePath: file2Path, extension: ".js", sizeBytes: 15 },
    ];

    const result = await parseFiles({ files: mockFiles });

    expect(result.totalParsedFiles).toBe(2);
    expect(result.failedFiles).toBe(0);
    expect(result.symbolFacts).toHaveLength(2);

    expect(result.symbolFacts[0].functions[0].name).toBe("main");
    expect(result.symbolFacts[1].classes[0].name).toBe("App");
  });

  it("should isolate errors when an individual file parsing returns an error without failing the job", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "parse-test-err-"));
    tmpDirs.push(tmpDir);

    const file1Path = path.join(tmpDir, "good.ts");
    const file2Path = path.join(tmpDir, "bad.js");

    await fs.promises.writeFile(file1Path, "function good() {}");
    await fs.promises.writeFile(file2Path, "syntax error");

    vi.spyOn(parserClient, "parseBatchWithService").mockImplementation(async (payload) => {
      return payload.files.map((f) => {
        if (f.filePath === "good.ts") {
          return {
            filePath: "good.ts",
            language: "typescript",
            functions: [{ name: "good", startLine: 1, endLine: 1, params: [] }],
            classes: [],
            imports: [],
            calls: [],
            error: null,
          };
        }
        return {
          filePath: "bad.js",
          language: "javascript",
          functions: [],
          classes: [],
          imports: [],
          calls: [],
          error: "Syntax error in file",
        };
      });
    });

    const mockFiles = [
      { relativePath: "good.ts", absolutePath: file1Path, extension: ".ts", sizeBytes: 20 },
      { relativePath: "bad.js", absolutePath: file2Path, extension: ".js", sizeBytes: 15 },
    ];

    const result = await parseFiles({ files: mockFiles });

    expect(result.totalParsedFiles).toBe(2);
    expect(result.failedFiles).toBe(1);
    expect(result.symbolFacts[0].error).toBeNull();
    expect(result.symbolFacts[1].error).toBe("Syntax error in file");
  });
});
