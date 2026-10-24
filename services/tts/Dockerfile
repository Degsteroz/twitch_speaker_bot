FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /service
COPY services/tts/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/tts/app ./app
COPY services/tts/download_models.py .
RUN useradd --create-home --uid 10001 tts && mkdir -p /models /cache && chown -R tts:tts /models /cache
USER tts
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
