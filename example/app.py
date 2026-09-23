"""Tiny demo Databricks App fronted by brickskate.

This app has no knowledge of Databricks itself. It only knows how to say
hello, count down to its own shutdown, and ask brickskate (over HTTP) to
put an event on EventBridge that eventually causes the Databricks Apps
API to stop this app.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

BRICKSKATE_URL = os.environ.get("BRICKSKATE_URL", "").rstrip("/")
BRICKSKATE_STOP_TOKEN = os.environ.get("BRICKSKATE_STOP_TOKEN", "")
LIFETIME_SECONDS = int(os.environ.get("LIFETIME_SECONDS", "180"))

STARTED_AT = time.time()

# The countdown arms on the first page view, not on process start. Waking an
# app takes a minute or two, and a clock that started with the process would
# already be half spent by the time the first visitor is redirected in.
STATE: dict = {
    "deadline": None,
    "stop_requested_at": None,
    "stop_http_status": None,
    "stop_error": None,
    "stop_reason": None,
}


def request_stop(reason: str) -> dict:
    """Idempotently ask brickskate to stop this app. Never raises."""
    if STATE["stop_requested_at"] is not None:
        return STATE

    STATE["stop_requested_at"] = time.time()
    STATE["stop_reason"] = reason

    if not BRICKSKATE_URL or not BRICKSKATE_STOP_TOKEN:
        STATE["stop_error"] = "brickskate not configured"
        return STATE

    url = f"{BRICKSKATE_URL}/stop"
    body = json.dumps({"reason": reason, "app": "example"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {BRICKSKATE_STOP_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            STATE["stop_http_status"] = resp.status
    except urllib.error.HTTPError as e:
        STATE["stop_http_status"] = e.code
    except Exception as e:  # noqa: BLE001 - record and move on, never crash
        STATE["stop_error"] = str(e)

    return STATE


async def request_stop_async(reason: str) -> dict:
    return await asyncio.to_thread(request_stop, reason)


_timer_task: asyncio.Task | None = None


async def _shutdown_timer(deadline: float) -> None:
    delay = deadline - time.time()
    if delay > 0:
        await asyncio.sleep(delay)
    await request_stop_async("timer")


def arm_timer() -> None:
    """Start the countdown on the first visit. Later visits do not reset it."""
    global _timer_task
    if STATE["deadline"] is not None:
        return
    STATE["deadline"] = time.time() + LIFETIME_SECONDS
    _timer_task = asyncio.create_task(_shutdown_timer(STATE["deadline"]))


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        yield
    finally:
        if _timer_task is not None:
            _timer_task.cancel()
            try:
                await _timer_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _status_payload() -> dict:
    now = time.time()
    deadline = STATE["deadline"]
    seconds_left = LIFETIME_SECONDS if deadline is None else max(0, int(deadline - now))
    return {
        "started_at": STARTED_AT,
        "deadline": deadline,
        "now": now,
        "seconds_left": seconds_left,
        "lifetime_seconds": LIFETIME_SECONDS,
        "wake_url": BRICKSKATE_URL,
        "configured": bool(BRICKSKATE_URL and BRICKSKATE_STOP_TOKEN),
        "stop_requested_at": STATE["stop_requested_at"],
        "stop_http_status": STATE["stop_http_status"],
        "stop_error": STATE["stop_error"],
        "stop_reason": STATE["stop_reason"],
    }


@app.get("/")
async def index() -> FileResponse:
    arm_timer()
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def api_status() -> dict:
    arm_timer()  # in case the page was cached and never hit /
    return _status_payload()


@app.post("/api/stop")
async def api_stop() -> dict:
    await request_stop_async("button")
    return _status_payload()


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}
