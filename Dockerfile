FROM node:20-alpine

# System dependencies: python3 (for yt-dlp), ffmpeg (for audio transcoding),
# curl (to download yt-dlp), and build tools (for native npm modules like opusscript)
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    build-base \
    # Needed for sodium/crypto native modules
    libffi-dev

# Install yt-dlp from the official GitHub releases (always latest stable)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src

# Health check: just verify the process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD pgrep -f "node src/index.js" || exit 1

CMD ["node", "src/index.js"]
