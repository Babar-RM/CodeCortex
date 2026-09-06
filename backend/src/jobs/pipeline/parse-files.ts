import fs from "fs";
import path from "path";
import { FetchedFile } from "./fetch-repo";
import { parseFileWithService, ExtractedFacts } from "../../lib/parser-client";

export interface ParseFilesParams {
  files: FetchedFile[];
}

export interface ParseFilesResult {
  totalParsedFiles: number;
  failedFiles: number;
  symbolFacts: ExtractedFacts[];
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
    case ".jsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "javascript";
  }
}

export async function parseFiles(params: ParseFilesParams): Promise<ParseFilesResult> {
  const symbolFacts: ExtractedFacts[] = [];
  let failedFiles = 0;

  for (const file of params.files) {
    try {
      const content = await fs.promises.readFile(file.absolutePath, "utf-8");
      const language = detectLanguage(file.relativePath);

      const facts = await parseFileWithService({
        filePath: file.relativePath,
        content,
        language,
      });

      if (facts.error) {
        console.warn(`[parse-files] Warning parsing ${file.relativePath}: ${facts.error}`);
        failedFiles++;
      }

      symbolFacts.push(facts);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to read file";
      console.warn(`[parse-files] Error reading/parsing ${file.relativePath}: ${errorMessage}`);
      failedFiles++;
      symbolFacts.push({
        filePath: file.relativePath,
        language: detectLanguage(file.relativePath),
        functions: [],
        classes: [],
        imports: [],
        calls: [],
        error: errorMessage,
      });
    }

  }

  return {
    totalParsedFiles: symbolFacts.length,
    failedFiles,
    symbolFacts,
  };
}
