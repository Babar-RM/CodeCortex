import fs from "fs";
import path from "path";
import { FetchedFile } from "./fetch-repo";
import { parseBatchWithService, parseFileWithService, ExtractedFacts } from "../../lib/parser-client";

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

const BATCH_SIZE = 50;       // Files per HTTP batch payload (RFC 0030)
const BATCH_CONCURRENCY = 4; // Concurrent batch requests in flight

/**
 * RFC 0030: Batch-parallel file parsing.
 * Chunks files into BATCH_SIZE groups, dispatches up to BATCH_CONCURRENCY
 * concurrent POST /parse-batch requests to the parser microservice.
 * Falls back to single-file sequential parsing if /parse-batch is unavailable.
 */
export async function parseFiles(params: ParseFilesParams): Promise<ParseFilesResult> {
  const symbolFacts: ExtractedFacts[] = [];
  let failedFiles = 0;

  // Read all file contents first (filesystem is local, fast)
  const fileContents: Array<{ file: FetchedFile; content: string } | { file: FetchedFile; error: string }> = [];
  for (const file of params.files) {
    try {
      const content = await fs.promises.readFile(file.absolutePath, "utf-8");
      fileContents.push({ file, content });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to read file";
      console.warn(`[parse-files] Error reading ${file.relativePath}: ${errorMessage}`);
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

  // Filter only successfully-read entries
  const readable = fileContents.filter(
    (entry): entry is { file: FetchedFile; content: string } => "content" in entry
  );

  if (readable.length === 0) {
    return { totalParsedFiles: symbolFacts.length, failedFiles, symbolFacts };
  }

  // Split into fixed-size chunks
  const chunks: Array<typeof readable> = [];
  for (let i = 0; i < readable.length; i += BATCH_SIZE) {
    chunks.push(readable.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `[parse-files] Dispatching ${readable.length} files across ${chunks.length} batch(es) ` +
    `(${BATCH_SIZE} files/batch, up to ${BATCH_CONCURRENCY} concurrent)`
  );

  // Process chunks in windows of BATCH_CONCURRENCY
  let processedChunks = 0;
  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    const window = chunks.slice(i, i + BATCH_CONCURRENCY);

    const batchResults = await Promise.all(
      window.map(async (chunk) => {
        const batchPayload = chunk.map((entry) => ({
          filePath: entry.file.relativePath,
          content: entry.content,
          language: detectLanguage(entry.file.relativePath),
        }));

        try {
          return await parseBatchWithService({ files: batchPayload });
        } catch {
          // parseBatchWithService already returns empty-fact arrays on error.
          // This catch is an extra safety net — should never be reached.
          return Promise.all(
            batchPayload.map((f) =>
              parseFileWithService({ filePath: f.filePath, content: f.content, language: f.language })
            )
          );
        }
      })
    );

    for (const chunkResults of batchResults) {
      for (const facts of chunkResults) {
        if (facts.error) {
          console.warn(`[parse-files] Parser warning for ${facts.filePath}: ${facts.error}`);
          failedFiles++;
        }
        symbolFacts.push(facts);
      }
    }

    processedChunks += window.length;
    console.log(`[parse-files] Completed ${processedChunks}/${chunks.length} batch(es)`);
  }

  return {
    totalParsedFiles: symbolFacts.length,
    failedFiles,
    symbolFacts,
  };
}
