from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_parse_js_function_and_imports():
    code = """
import { useState } from 'react';

function calculateTotal(items: number[]): number {
    console.log("calculating");
    return items.reduce((acc, curr) => acc + curr, 0);
}

export class Calculator extends BaseCalculator {
    run() {
        calculateTotal([1, 2, 3]);
    }
}
"""
    payload = {
        "file_path": "src/calculator.ts",
        "content": code,
        "language": "typescript",
    }
    response = client.post("/parse", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["file_path"] == "src/calculator.ts"
    assert data["language"] == "typescript"
    assert data["error"] is None

    # Verify functions
    func_names = [f["name"] for f in data["functions"]]
    assert "calculateTotal" in func_names

    # Verify classes
    class_names = [c["name"] for c in data["classes"]]
    assert "Calculator" in class_names
    assert len(data["classes"]) == 1
    assert "BaseCalculator" in data["classes"][0]["heritage"]

    # Verify imports
    import_sources = [i["source_path"] for i in data["imports"]]
    assert "react" in import_sources

    # Verify call sites
    callees = [c["callee_name"] for c in data["calls"]]
    assert "console.log" in callees or "calculateTotal" in callees


def test_parse_invalid_syntax_handles_gracefully():
    payload = {
        "file_path": "src/broken.js",
        "content": "const x = ; // syntax error",
        "language": "javascript",
    }
    response = client.post("/parse", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["file_path"] == "src/broken.js"
