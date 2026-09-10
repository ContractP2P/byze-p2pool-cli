FROM node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2 AS node-runtime

FROM ubuntu@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_SNAPSHOT=20260909T120000Z

# Bootstrap HTTPS trust from another immutable image.
COPY --from=node-runtime \
  /etc/ssl/certs/ca-certificates.crt \
  /etc/ssl/certs/ca-certificates.crt

RUN apt-get update --snapshot "${APT_SNAPSHOT}" && \
    apt-get install -y \
      --no-install-recommends \
      --snapshot "${APT_SNAPSHOT}" \
      "ca-certificates=20260601~24.04.1" \
      "openssl=3.0.13-0ubuntu3.15" \
      "pkg-config=1.8.1-2build1" \
      "gcc=4:13.2.0-7ubuntu1" \
      "g++=4:13.2.0-7ubuntu1" \
      "gcc-13=13.3.0-6ubuntu2~24.04.1" \
      "g++-13=13.3.0-6ubuntu2~24.04.1" \
      "cpp-13=13.3.0-6ubuntu2~24.04.1" \
      "binutils=2.42-4ubuntu2.10" \
      "cmake=3.28.3-1build7" \
      "make=4.3-4.1build2" \
      "git=1:2.43.0-1ubuntu7.3" \
      "libboost-dev=1.83.0.1ubuntu2" \
      "libboost1.83-dev=1.83.0-2.1ubuntu3.2" \
      "libssl-dev=3.0.13-0ubuntu3.15" \
      "libssl3t64=3.0.13-0ubuntu3.15" \
      "libc6=2.39-0ubuntu8.8" \
      "libc6-dev=2.39-0ubuntu8.8" \
      "libc-dev-bin=2.39-0ubuntu8.8" \
      "libgcc-13-dev=13.3.0-6ubuntu2~24.04.1" \
      "libstdc++-13-dev=13.3.0-6ubuntu2~24.04.1" \
      "libgcc-s1=14.2.0-4ubuntu2~24.04.1" \
      "libstdc++6=14.2.0-4ubuntu2~24.04.1" \
    && rm -rf /var/lib/apt/lists/*

# Only Node itself is required by the native build tooling.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

WORKDIR /workspaces/contract-dev/cli

RUN set -eux; \
    node --version; \
    gcc --version | head -1; \
    g++ --version | head -1; \
    cmake --version | head -1; \
    ld --version | head -1; \
    git --version; \
    dpkg-query -W -f='${Package}\t${Version}\n' \
      gcc-13 \
      g++-13 \
      binutils \
      cmake \
      libboost1.83-dev \
      libssl-dev \
      libc6 \
      libc6-dev \
      libstdc++6
