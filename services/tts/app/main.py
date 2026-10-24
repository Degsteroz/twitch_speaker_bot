from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
import wave
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

Voice = Literal["male", "female"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")
    model_dir: Path = Path("/models")
    cache_dir: Path = Path("/cache")
    male_model: str = "ru_RU-denis-medium.onnx"
    female_model: str = "ru_RU-irina-medium.onnx"
    cache_max_age_seconds: int = 24 * 60 * 60
    preload_voices: bool = True


class SynthRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    voice: Voice


settings = Settings()

# Loading an ONNX voice takes about a second, so each voice is loaded once and reused. Piper
# sessions are not documented as thread-safe; one lock per voice serialises synthesis.
_voices: dict[str, object] = {}
_voice_locks: dict[str, threading.Lock] = {"male": threading.Lock(), "female": threading.Lock()}
_load_lock = threading.Lock()
_last_prune = 0.0


def model_path(voice: Voice) -> Path:
    name = settings.male_model if voice == "male" else settings.female_model
    candidate = (settings.model_dir / name).resolve()
    if candidate.parent != settings.model_dir.resolve():
        raise RuntimeError("Configured model must be inside MODEL_DIR")
    return candidate


def config_path(voice: Voice) -> Path:
    return model_path(voice).with_suffix(".onnx.json")


def load_voice(voice: Voice):
    with _load_lock:
        loaded = _voices.get(voice)
        if loaded is None:
            from piper import PiperVoice

            loaded = PiperVoice.load(model_path(voice), config_path=config_path(voice))
            _voices[voice] = loaded
        return loaded


def prune_cache() -> None:
    """Drop cached WAVs older than CACHE_MAX_AGE_SECONDS at most once per hour."""
    global _last_prune
    now = time.time()
    if now - _last_prune < 3600:
        return
    _last_prune = now
    cutoff = now - settings.cache_max_age_seconds
    for entry in settings.cache_dir.glob("*.wav"):
        try:
            if entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
        except OSError:
            pass


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if settings.preload_voices:
        for voice in ("male", "female"):
            if model_path(voice).is_file() and config_path(voice).is_file():
                load_voice(voice)  # type: ignore[arg-type]
    yield


app = FastAPI(title="RoastBot TTS", version="1.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    models = {
        voice: model_path(voice).is_file() and config_path(voice).is_file()
        for voice in ("male", "female")
    }
    return {"ok": all(models.values()), "models": models, "loaded": sorted(_voices)}


@app.post("/synth", response_class=FileResponse)
def synthesize(request: SynthRequest) -> FileResponse:
    if not model_path(request.voice).is_file() or not config_path(request.voice).is_file():
        raise HTTPException(status_code=503, detail=f"{request.voice} voice unavailable")
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    prune_cache()
    model_name = model_path(request.voice).name
    digest = hashlib.sha256(
        f"v2\0{model_name}\0{request.text}".encode("utf-8")
    ).hexdigest()
    cached = settings.cache_dir / f"{digest}.wav"
    if not cached.exists():
        descriptor, temporary_name = tempfile.mkstemp(
            dir=settings.cache_dir, prefix=f".{digest}.", suffix=".tmp"
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            voice = load_voice(request.voice)
            with _voice_locks[request.voice], wave.open(str(temporary), "wb") as wav_file:
                voice.synthesize_wav(request.text, wav_file)  # type: ignore[attr-defined]
            if temporary.stat().st_size <= 44:
                raise RuntimeError("Piper produced no audio")
            temporary.replace(cached)
        except HTTPException:
            raise
        except Exception as error:  # noqa: BLE001 - any synthesis failure maps to 502
            temporary.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail="synthesis failed") from error
    else:
        cached.touch()
    return FileResponse(cached, media_type="audio/wav", filename="roast.wav")
