from fastapi import FastAPI
from app.schemas import (
    ParseRequest, ParseResponse,
    BatchParseRequest, BatchParseResponse,
    EmbedRequest, EmbedResponse,
)
from app.parsers.javascript import parse_js_ts_file
from app.embeddings import generate_embeddings

app = FastAPI(
    title="CodeCortex Parser Microservice",
    description="Internal tree-sitter AST structural parsing & local embedding microservice",
    version="0.1.0",
)


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/parse", response_model=ParseResponse)
def parse_file(payload: ParseRequest) -> ParseResponse:
    ext = payload.file_path.split(".")[-1].lower() if "." in payload.file_path else ""

    if ext in ("js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts") or payload.language in (
        "javascript",
        "typescript",
    ):
        return parse_js_ts_file(payload.file_path, payload.content, payload.language)

    return ParseResponse(
        file_path=payload.file_path,
        language=payload.language,
        functions=[],
        classes=[],
        imports=[],
        calls=[],
    )


@app.post("/embed", response_model=EmbedResponse)
def embed_texts(payload: EmbedRequest) -> EmbedResponse:
    try:
        vectors = generate_embeddings(payload.texts)
        return EmbedResponse(embeddings=vectors)
    except Exception as e:
        return EmbedResponse(embeddings=[], error=str(e))


@app.post("/parse-batch", response_model=BatchParseResponse)
def parse_files_batch(payload: BatchParseRequest) -> BatchParseResponse:
    """Batch parse multiple files in a single HTTP round-trip (RFC 0030)."""
    results = []
    for item in payload.files:
        results.append(
            parse_file(
                ParseRequest(
                    file_path=item.file_path,
                    content=item.content,
                    language=item.language,
                )
            )
        )
    return BatchParseResponse(results=results)

