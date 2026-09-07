from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_model: Any = None
MODEL_NAME = "BAAI/bge-small-en-v1.5"
VECTOR_DIMENSION = 384


def get_embedding_model():
    global _model
    if _model is None:
        try:
            from sentence_transformers import SentenceTransformer

            logger.info("Loading sentence transformer model: %s", MODEL_NAME)
            _model = SentenceTransformer(MODEL_NAME)
        except Exception as e:
            logger.warning("Failed to load sentence_transformers model %s: %s", MODEL_NAME, e)
            _model = False
    return _model


def generate_embeddings(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []

    model = get_embedding_model()

    if model and model is not False:
        try:
            embeddings = model.encode(texts, normalize_embeddings=True)
            return [vec.tolist() for vec in embeddings]
        except Exception as e:
            logger.exception("Error during model inference: %s", e)

    # Fallback deterministic vector generator for environments without model weights or testing
    results: list[list[float]] = []
    for text in texts:
        # Generate 384-dimensional normalized pseudo-vector derived from text hash
        val = float(hash(text) % 1000) / 1000.0
        vec = [(val + i * 0.001) % 1.0 for i in range(VECTOR_DIMENSION)]
        norm = sum(v * v for v in vec) ** 0.5 or 1.0
        results.append([round(v / norm, 6) for v in vec])

    return results
