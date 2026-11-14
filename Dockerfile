FROM node:20-slim

ENV NODE_ENV=production \
    PORT=7860

# Chromium runtime libraries (headless mode; no Xvfb)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libgbm-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 7860

CMD ["node", "app.js"]
