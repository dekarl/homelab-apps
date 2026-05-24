# voice-transcription-bot
# Matrix bot that transcribes voice messages using whisper.cpp (flinker:8081)

FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy bot source
COPY main.py .

# Run as non-root user
RUN useradd -m -u 1000 botuser && chown -R botuser:botuser /app
USER botuser

# matrix-nio session store lives on a PVC mounted at /data
ENV STORE_PATH=/data/nio-store

CMD ["python", "-u", "main.py"]
