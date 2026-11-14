# syntax=docker/dockerfile:1.7

FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DISPLAY=:99 \
    PORT=7860 \
    HOME=/home/node \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# Xvfb and Chromium runtime dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libgbm-dev \
        libasound2 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        libxtst6 \
        fonts-liberation \
        ca-certificates \
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN chown node:node /app
COPY --chown=node:node package*.json ./
USER node

# No package-lock.json is committed, so use npm install instead of npm ci.
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .

EXPOSE 7860

# Start Xvfb in the background and keep node as the foreground process.
CMD ["sh", "-c", "mkdir -p /tmp/.X11-unix; Xvfb :99 -screen 0 1920x1080x24 & until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.1; done; exec node app.js"]
