# Builds Node.js v24.21.0 from source with the embedder-allocation-rate patch applied.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 g++ make ninja-build pkg-config patch \
    && rm -rf /var/lib/apt/lists/*
ARG NODE_VERSION=24.21.0
WORKDIR /src
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.xz | tar -xJ --strip-components=1
COPY 0001-heap-treat-zero-embedder-allocation-rate-as-low.patch /tmp/
# APPLY_PATCH=0 builds the unpatched control from the same source/toolchain.
ARG APPLY_PATCH=1
RUN if [ "$APPLY_PATCH" = 1 ]; then patch -p1 < /tmp/0001-heap-treat-zero-embedder-allocation-rate-as-low.patch; fi
ARG JOBS=16
RUN ./configure --ninja && ninja -C out/Release -j${JOBS} node

FROM node:24.21.0-bookworm-slim
COPY --from=build /src/out/Release/node /usr/local/bin/node
