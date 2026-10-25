# Python detection worker. Build context = repo root. CPU base; see compose for GPU.
FROM python:3.12-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# OpenCV / ffmpeg runtime libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# uv for fast, reproducible installs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY worker/pyproject.toml worker/uv.lock* ./
RUN uv sync --frozen --no-dev || uv sync --no-dev
COPY worker/ /app/
RUN useradd -r -u 10002 app && mkdir -p /models /media && chown -R app /app /models /media
USER app
ENV MODEL_CACHE_DIR=/models
CMD ["uv", "run", "python", "-m", "cameraman_worker"]
