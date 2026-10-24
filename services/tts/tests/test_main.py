"""HTTP contract tests for the TTS wrapper with Piper replaced by a fake voice.

Run with: MODEL_DIR=<tmp> CACHE_DIR=<tmp> python -m unittest discover -s tests
"""

from __future__ import annotations

import os
import tempfile
import unittest
import wave
from pathlib import Path

_root = Path(tempfile.mkdtemp(prefix="roastbot-tts-"))
os.environ["MODEL_DIR"] = str(_root / "models")
os.environ["CACHE_DIR"] = str(_root / "cache")
os.environ["PRELOAD_VOICES"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402


class FakeVoice:
    def __init__(self) -> None:
        self.calls = 0

    def synthesize_wav(self, text: str, wav_file: wave.Wave_write) -> None:
        self.calls += 1
        if not any(character.isalpha() for character in text):
            return  # Piper writes no frames for text without speakable characters.
        wav_file.setframerate(22050)
        wav_file.setsampwidth(2)
        wav_file.setnchannels(1)
        wav_file.writeframes(b"\x00\x01" * 2205)


class SynthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        models = _root / "models"
        models.mkdir(parents=True, exist_ok=True)
        (models / "ru_RU-irina-medium.onnx").write_bytes(b"onnx")
        (models / "ru_RU-irina-medium.onnx.json").write_text("{}")
        cls.voice = FakeVoice()
        main._voices.update({"female": cls.voice})
        cls.client = TestClient(main.app)

    def test_health_needs_only_the_female_voice(self) -> None:
        body = self.client.get("/health").json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["models"], {"female": True})

    def test_male_requests_from_older_workers_use_the_same_voice(self) -> None:
        response = self.client.post("/synth", json={"text": "Старый воркер", "voice": "male"})
        self.assertEqual(response.status_code, 200)
        no_voice = self.client.post("/synth", json={"text": "Без поля voice"})
        self.assertEqual(no_voice.status_code, 200)

    def test_synth_returns_wav_and_caches(self) -> None:
        before = self.voice.calls
        first = self.client.post("/synth", json={"text": "Ну и катка", "voice": "female"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers["content-type"], "audio/wav")
        self.assertEqual(first.content[:4], b"RIFF")
        second = self.client.post("/synth", json={"text": "Ну и катка", "voice": "female"})
        self.assertEqual(second.content, first.content)
        self.assertEqual(self.voice.calls, before + 1)

    def test_unspeakable_text_is_a_clean_502(self) -> None:
        response = self.client.post("/synth", json={"text": "...", "voice": "male"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(list((_root / "cache").glob("*.tmp")), [])

    def test_validates_input(self) -> None:
        self.assertEqual(self.client.post("/synth", json={"text": "", "voice": "male"}).status_code, 422)
        self.assertEqual(
            self.client.post("/synth", json={"text": "а" * 201, "voice": "male"}).status_code, 422
        )
        self.assertEqual(self.client.post("/synth", json={"text": "hi", "voice": "robot"}).status_code, 422)

    def test_missing_model_is_503(self) -> None:
        model = _root / "models" / "ru_RU-irina-medium.onnx"
        model.rename(model.with_suffix(".bak"))
        try:
            response = self.client.post("/synth", json={"text": "Привет", "voice": "male"})
            self.assertEqual(response.status_code, 503)
        finally:
            model.with_suffix(".bak").rename(model)


if __name__ == "__main__":
    unittest.main()
