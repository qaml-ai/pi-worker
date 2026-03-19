FROM docker.io/cloudflare/sandbox:0.7.18

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
