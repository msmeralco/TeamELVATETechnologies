"""Prediction engine HTTP service (internal; called by the backend only)."""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

import model

app = FastAPI(title="Meralco Go prediction engine", version="1.0.0")

MAX_POINTS = 96 * 21  # 3 weeks of 15-minute readings per series


class MeterSeries(BaseModel):
    meter_id: str = Field(max_length=32)
    kwh: list[Optional[float]] = Field(max_length=MAX_POINTS)
    anomaly_signature: bool = False


class ScoreRequest(BaseModel):
    meters: list[MeterSeries] = Field(max_length=500)


class ForecastRequest(BaseModel):
    meter_id: str = Field(max_length=32)
    kwh: list[Optional[float]] = Field(max_length=MAX_POINTS)
    temp_c: list[Optional[float]] = Field(default_factory=list, max_length=MAX_POINTS)
    last_slot_of_day: int = Field(ge=0, lt=model.SLOTS_PER_DAY)
    used_kwh: float = Field(ge=0)
    remaining_slots: int = Field(ge=0, le=96 * 62)
    extra_kwh_per_day: float = Field(default=0.0, ge=0, le=100)
    temp_outlook_c: Optional[float] = Field(default=None, ge=0, le=50)


class BalanceRequest(BaseModel):
    transformer_id: str = Field(max_length=32)
    dt_kwh: list[Optional[float]] = Field(max_length=MAX_POINTS)
    meters_kwh: list[Optional[float]] = Field(max_length=MAX_POINTS)


@app.get("/health")
def health():
    return {"status": "ok", "model_version": model.MODEL_VERSION}


@app.post("/v1/scores")
def scores(req: ScoreRequest):
    return {"scores": [{"meter_id": m.meter_id, **model.score_meter(m.kwh, m.anomaly_signature)} for m in req.meters]}


@app.post("/v1/forecasts")
def forecasts(req: ForecastRequest):
    return {"meter_id": req.meter_id, **model.forecast_cycle(
        req.kwh, req.temp_c, req.last_slot_of_day, req.used_kwh, req.remaining_slots,
        req.extra_kwh_per_day, req.temp_outlook_c)}


@app.post("/v1/balances")
def balances(req: BalanceRequest):
    return {"transformer_id": req.transformer_id, **model.transformer_balance(req.dt_kwh, req.meters_kwh)}
