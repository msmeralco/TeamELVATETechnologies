"""Vercel Python function: the prediction engine, served from the same deployment.

Reuses prediction-engine/app.py unchanged (the FastAPI `app`), so local
`uvicorn app:app` and Vercel run identical code. vercel.json rewrites
/api/engine/* to this function. Depending on whether the platform hands the
ASGI app the original or the rewritten path, the engine routes appear either
under /api/engine or at the root, so the app is mounted at both.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "prediction-engine"))

from fastapi import FastAPI  # noqa: E402
from app import app as engine  # noqa: E402  (prediction-engine/app.py)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/api/engine", engine)
app.mount("/", engine)
