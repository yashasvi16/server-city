# syntax=docker/dockerfile:1
# Full stack in one small image: the Go server also serves the built frontend.

# ── 1. frontend ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── 2. backend (standard library only, static binary) ───────────────────────
FROM golang:1.24-alpine AS api
ARG VERSION=dev
WORKDIR /src
COPY backend/go.mod ./
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X github.com/yashasvi16/server-city/backend/internal/api.Version=${VERSION}" \
      -o /out/server ./cmd/server \
 && mkdir -p /out/data

# ── 3. runtime: distroless, non-root, no shell ──────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /out/server /server
COPY --from=web /web/dist /site
# Writable data dir owned by the nonroot user (uid 65532); mount a volume here.
COPY --from=api --chown=65532:65532 /out/data /data
ENV ADDR=:8080 STATIC_DIR=/site DATA_DIR=/data LOG_LEVEL=info
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
