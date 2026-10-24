from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path


MODEL_DIR = Path(os.getenv("MODEL_DIR", "/models"))


def download(name: str, url_env: str, sha_env: str) -> None:
    url = os.environ[url_env]
    expected = os.environ[sha_env].lower()
    if len(expected) != 64:
        raise ValueError(f"{sha_env} must be a SHA-256 hex digest")
    destination = MODEL_DIR / name
    temporary = destination.with_suffix(destination.suffix + ".download")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        digest = hashlib.sha256()
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum mismatch for {name}")
    temporary.replace(destination)


MODEL_DIR.mkdir(parents=True, exist_ok=True)
for voice, filename in (
    ("DENIS", "ru_RU-denis-medium.onnx"),
    ("DENIS_CONFIG", "ru_RU-denis-medium.onnx.json"),
    ("IRINA", "ru_RU-irina-medium.onnx"),
    ("IRINA_CONFIG", "ru_RU-irina-medium.onnx.json"),
):
    download(filename, f"{voice}_URL", f"{voice}_SHA256")
