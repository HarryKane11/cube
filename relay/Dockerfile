# syntax=docker/dockerfile:1

# ---- build ---------------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY proto ./proto
COPY server ./server
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p cube-relay --bin cube-relay \
 && cp target/release/cube-relay /usr/local/bin/cube-relay

# ---- run -----------------------------------------------------------------
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --user-group --home-dir /data --shell /usr/sbin/nologin cube \
 && mkdir -p /data \
 && chown cube:cube /data \
 && chmod 700 /data
COPY --from=build /usr/local/bin/cube-relay /usr/local/bin/cube-relay

USER cube
WORKDIR /data
# Inside a container the relay listens on every interface, so
# CUBE_RELAY_PUBLIC_HOST must be set or it refuses to start.
ENV CUBE_RELAY_BIND=0.0.0.0:8484 \
    CUBE_RELAY_DB=/data/cube-relay.db
VOLUME /data
EXPOSE 8484
ENTRYPOINT ["cube-relay"]
