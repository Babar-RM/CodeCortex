import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def mock_embedding_model(monkeypatch):
    # Set model to False so tests use deterministic fallback generator without downloading model weights in CI
    monkeypatch.setattr("app.embeddings._model", False)


def test_embed_endpoint_returns_384_dim_vectors():
    payload = {
        "texts": [
            "function calculateTotal(items: number[]): number",
            "class Calculator extends BaseCalculator",
        ]
    }
    response = client.post("/embed", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert "embeddings" in data
    assert len(data["embeddings"]) == 2
    assert len(data["embeddings"][0]) == 384
    assert len(data["embeddings"][1]) == 384
    assert data["error"] is None


def test_embed_empty_array():
    response = client.post("/embed", json={"texts": []})
    assert response.status_code == 200
    assert response.json()["embeddings"] == []
