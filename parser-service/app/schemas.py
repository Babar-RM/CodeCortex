from pydantic import BaseModel, Field


class ParseRequest(BaseModel):
    file_path: str = Field(..., description="Relative file path within repository")
    content: str = Field(..., description="Source code text content")
    language: str = Field(..., description="Language identifier (javascript, typescript)")


class FunctionFact(BaseModel):
    name: str = Field(..., description="Function or method name")
    start_line: int = Field(..., description="1-indexed starting line number")
    end_line: int = Field(..., description="1-indexed ending line number")
    params: list[str] = Field(default_factory=list, description="Parameter name list")
    return_type: str | None = Field(default=None, description="Extracted return type if available")


class ClassFact(BaseModel):
    name: str = Field(..., description="Class name")
    start_line: int = Field(..., description="1-indexed starting line number")
    end_line: int = Field(..., description="1-indexed ending line number")
    heritage: list[str] = Field(default_factory=list, description="Extends/inherits class names")


class ImportFact(BaseModel):
    source_path: str = Field(..., description="Import source module path")
    imported_symbols: list[str] = Field(default_factory=list, description="Imported symbol names")


class CallFact(BaseModel):
    caller_name: str = Field(..., description="Enclosing caller function name")
    callee_name: str = Field(..., description="Invoked callee function or method name")
    line_number: int = Field(..., description="1-indexed line number of invocation")


class ParseResponse(BaseModel):
    file_path: str = Field(..., description="Relative file path")
    language: str = Field(..., description="Language identifier")
    functions: list[FunctionFact] = Field(default_factory=list)
    classes: list[ClassFact] = Field(default_factory=list)
    imports: list[ImportFact] = Field(default_factory=list)
    calls: list[CallFact] = Field(default_factory=list)
    error: str | None = Field(default=None, description="Syntax or processing error message if any")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., description="Array of text chunks or symbol descriptions to embed")


class EmbedResponse(BaseModel):
    embeddings: list[list[float]] = Field(..., description="Array of 384-dimensional dense vectors")
    error: str | None = Field(default=None, description="Error message if inference failed")

