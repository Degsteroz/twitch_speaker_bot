# RoastBot TTS

FastAPI wrapper around Piper. It is the **emergency voice only**: the worker calls it when every
cloud voice of a roast (ElevenLabs, Inworld, Yandex SpeechKit) has failed, timed out, hit its limit
or is not configured. The service has no internet access.

- `POST /synth` accepts `{ "text": "...", "voice": "female" }` with a hard 200-character limit and
  returns a WAV. `voice` is still accepted for older workers (`male` too) and ignored: both
  characters are female, so there is one voice, `ru_RU-irina-medium`.
- `GET /health` reports whether the model is present and loaded.

The voice is loaded once (at startup, or on the first request when `PRELOAD_VOICES=false`) and
reused; no shell or subprocess. Synthesis is serialised by a lock. Results are written atomically to
a content-addressed WAV cache, pruned of files older than `CACHE_MAX_AGE_SECONDS`.

Configure the model filename with `FEMALE_MODEL` (default `ru_RU-irina-medium.onnx`, inside
`MODEL_DIR`). The service does not bundle model files. `download_models.py` fetches them only with
explicit URLs and SHA-256 values: `IRINA_URL`, `IRINA_SHA256`, `IRINA_CONFIG_URL`,
`IRINA_CONFIG_SHA256`, and refuses a file with a wrong checksum.

`piper-tts` wheels for macOS arm64 (1.3.0–1.8.0) cannot find espeak-ng data; run the service in a
Linux container. The tests (`python -m unittest discover -s tests -t .`) stub the voice and run
anywhere.

## Licensing caveat

The license/provenance of the `ru_RU-irina-medium` model is currently unknown. Do not redistribute
or deploy that model commercially until its license has been independently verified. Operators
must supply the model files and accept their applicable terms.
