# PAN Docker - single container, zero config
# Usage: docker compose up -d && open http://localhost:7777
#
# Target size: ~350MB (down from 5.4GB)

# === Stage 1: Build (install deps + compile native modules) ===
FROM node:22-bookworm-slim AS builder

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Install server deps (layer cached unless package.json changes)
COPY service/package.json service/package-lock.json* ./service/
RUN cd service && npm install --omit=dev --no-audit --no-fund

# Copy server source
COPY service/src/ ./service/src/
COPY service/public/ ./service/public/
COPY service/pan.js ./service/

# Build dashboard if source exists
COPY service/dashboard/ ./service/dashboard/
RUN if [ -f service/dashboard/package.json ]; then \
        cd service/dashboard && \
        npm install --no-audit --no-fund && \
        npm run build && \
        rm -rf node_modules; \
    fi

# === Stage 2: Runtime (slim, no build tools) ===
FROM node:22-bookworm-slim

# Only curl needed at runtime (for health checks)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pan

# Copy built artifacts from builder (no build-essential, no python)
COPY --from=builder /build/service/node_modules ./service/node_modules
COPY --from=builder /build/service/src ./service/src
COPY --from=builder /build/service/public ./service/public
COPY --from=builder /build/service/pan.js ./service/
COPY --from=builder /build/service/package.json ./service/

# Data directory
RUN mkdir -p /data/backups /data/recordings /data/terminal-logs /data/transcripts && \
    node -e "const c=require('crypto'); \
      require('fs').writeFileSync('/data/pan.key', c.randomBytes(32).toString('hex')); \
      require('fs').writeFileSync('/data/audit.key', c.randomBytes(32).toString('hex'));" && \
    chmod 600 /data/pan.key /data/audit.key

ENV PAN_SERVICE=1
ENV PAN_DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 7777

WORKDIR /opt/pan/service
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -sf http://127.0.0.1:7777/health || exit 1

CMD ["node", "pan.js", "start"]
