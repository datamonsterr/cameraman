# Multi-stage build for the Rust backend. Build context = repo root.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Cache deps: copy manifests first.
COPY backend/Cargo.toml backend/Cargo.lock* ./backend/
WORKDIR /src/backend
RUN mkdir -p src && echo 'fn main(){}' > src/main.rs \
    && cargo build --release 2>/dev/null || true
# Now the real sources + migrations.
COPY backend/ /src/backend/
COPY db/migrations /src/db/migrations
ENV SQLX_OFFLINE=true
RUN cargo build --release && cp target/release/cameraman /cameraman

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 app
COPY --from=build /cameraman /usr/local/bin/cameraman
COPY backend/migrations /app/migrations
WORKDIR /app
USER app
EXPOSE 8080
ENV BACKEND_BIND=0.0.0.0:8080
CMD ["cameraman"]
