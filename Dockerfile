# Use Debian-based Node (not Alpine) to avoid musl/glibc compatibility issues
# with native modules and the yt-dlp binary.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip so it runs on the system Python (no glibc/musl mismatch)
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD pgrep -f "node src/index.js" || exit 1

CMD ["node", "src/index.js"]
