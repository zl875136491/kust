FROM rust:1.97-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY src ./src
RUN cargo build --release --locked

FROM builder AS test
RUN rustup component add clippy rustfmt \
    && cargo fmt --all -- --check \
    && cargo clippy --all-targets --locked -- -D warnings \
    && cargo test --locked

FROM debian:bookworm-slim AS runtime

ARG VCS_REF=unknown
ARG IMAGE_VERSION=dev
ARG SOURCE_URL=https://github.com/zl875136491/kust

LABEL org.opencontainers.image.authors="NC_SIT_ZHANGLE" \
      org.opencontainers.image.title="Kust API" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.component="backend"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 kust
COPY --from=builder /app/target/release/kust-api /usr/local/bin/kust-api

ENV LISTEN_ADDR=0.0.0.0:8080

USER kust
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["kust-api"]
