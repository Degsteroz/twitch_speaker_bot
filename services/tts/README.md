# RoastBot TTS

FastAPI wrapper around Piper. `POST /synth` accepts `{ "text": "...", "voice": "male|female" }`
with a hard 200-character limit. Both voices are loaded once at startup and reused (no shell, no subprocess);
results are written atomically to a content-addressed WAV cache.

Models default to `ru_RU-denis-medium` and `ru_RU-irina-medium`. Configure model filenames with
`MALE_MODEL` and `FEMALE_MODEL`. `download_models.py` requires explicit URLs and SHA-256 values:
`DENIS_URL`, `DENIS_SHA256`, `DENIS_CONFIG_URL`, `DENIS_CONFIG_SHA256`, and corresponding
`IRINA_*` variables.

## Licensing caveat

The license/provenance of the `ru_RU-irina-medium` model is currently unknown. Do not redistribute
or deploy that model commercially until its license has been independently verified. The service
does not bundle model files; operators must supply them and accept their applicable terms.
