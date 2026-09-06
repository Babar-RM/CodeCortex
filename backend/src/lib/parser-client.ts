export interface ParseFilePayload {
  filePath: string;
  content: string;
  language: string;
}

export interface FunctionFact {
  name: string;
  startLine: number;
  endLine: number;
  params: string[];
  returnType?: string | null;
}

export interface ClassFact {
  name: string;
  startLine: number;
  endLine: number;
  heritage: string[];
}

export interface ImportFact {
  sourcePath: string;
  importedSymbols: string[];
}

export interface CallFact {
  callerName: string;
  calleeName: string;
  lineNumber: number;
}

export interface ExtractedFacts {
  filePath: string;
  language: string;
  functions: FunctionFact[];
  classes: ClassFact[];
  imports: ImportFact[];
  calls: CallFact[];
  error?: string | null;
}

const PARSER_SERVICE_URL = process.env.PARSER_SERVICE_URL || "http://localhost:8001";

interface ParserRawFunction {
  name: string;
  start_line: number;
  end_line: number;
  params?: string[];
  return_type?: string | null;
}

interface ParserRawClass {
  name: string;
  start_line: number;
  end_line: number;
  heritage?: string[];
}

interface ParserRawImport {
  source_path: string;
  imported_symbols?: string[];
}

interface ParserRawCall {
  caller_name: string;
  callee_name: string;
  line_number: number;
}

interface ParserRawResponse {
  file_path: string;
  language: string;
  functions?: ParserRawFunction[];
  classes?: ParserRawClass[];
  imports?: ParserRawImport[];
  calls?: ParserRawCall[];
  error?: string | null;
}

export async function parseFileWithService(payload: ParseFilePayload): Promise<ExtractedFacts> {
  try {
    const response = await fetch(`${PARSER_SERVICE_URL}/parse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_path: payload.filePath,
        content: payload.content,
        language: payload.language,
      }),
    });

    if (!response.ok) {
      return {
        filePath: payload.filePath,
        language: payload.language,
        functions: [],
        classes: [],
        imports: [],
        calls: [],
        error: `Parser service returned HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as ParserRawResponse;

    return {
      filePath: data.file_path,
      language: data.language,
      functions: (data.functions || []).map((f) => ({
        name: f.name,
        startLine: f.start_line,
        endLine: f.end_line,
        params: f.params || [],
        returnType: f.return_type || null,
      })),
      classes: (data.classes || []).map((c) => ({
        name: c.name,
        startLine: c.start_line,
        endLine: c.end_line,
        heritage: c.heritage || [],
      })),
      imports: (data.imports || []).map((i) => ({
        sourcePath: i.source_path,
        importedSymbols: i.imported_symbols || [],
      })),
      calls: (data.calls || []).map((cl) => ({
        callerName: cl.caller_name,
        calleeName: cl.callee_name,
        lineNumber: cl.line_number,
      })),
      error: data.error || null,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Failed to communicate with parser-service";
    return {
      filePath: payload.filePath,
      language: payload.language,
      functions: [],
      classes: [],
      imports: [],
      calls: [],
      error: errorMessage,
    };
  }
}


export async function checkParserHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PARSER_SERVICE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function embedTextsWithService(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  try {
    const response = await fetch(`${PARSER_SERVICE_URL}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ texts }),
    });

    if (!response.ok) {
      throw new Error(`Parser service /embed returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as { embeddings?: number[][]; error?: string };
    if (data.error) {
      throw new Error(data.error);
    }

    return data.embeddings || [];
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Failed to generate embeddings";
    console.warn(`[parser-client] Error calling /embed: ${errorMessage}`);
    // Return empty vectors on failure to preserve error isolation
    return texts.map(() => []);
  }
}

