# ---------- Stage 1: build cfsolve (Rust) ----------
FROM rust:1-bookworm AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake libclang-dev pkg-config libssl-dev git unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# Ekstrak cfsolve.zip bila ada; kalau tidak, clone dari GitHub
RUN if [ -f cfsolve.zip ]; then unzip -q cfsolve.zip && rm -f cfsolve.zip; fi && \
    if [ ! -d cfsolve ]; then \
      git clone --depth 1 https://github.com/chris124567/cfsolve.git cfsolve; \
    fi && \
    test -d cfsolve

WORKDIR /src/cfsolve
RUN cargo build --release --bin challenge

# ---------- Stage 2: Node runtime ----------
FROM node:22-bookworm-slim

WORKDIR /app

# Install unzip untuk mengekstrak profiles.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY app.js ./

# EKSTRAK PROFILES.ZIP KE DALAM /app/profiles/
COPY profiles.zip /app/profiles.zip
RUN mkdir -p /app/profiles && \
    unzip /app/profiles.zip -d /app/profiles/ && \
    rm /app/profiles.zip

# Copy binary cfsolve dari stage 1
COPY --from=rust-builder /src/cfsolve/target/release/challenge /usr/local/bin/challenge

ENV NODE_ENV=production
ENV CFSOLVE_BIN=/usr/local/bin/challenge
ENV PORT=3000

EXPOSE 3000
CMD ["node", "app.js"]
