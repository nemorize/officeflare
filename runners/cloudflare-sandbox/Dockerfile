FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /workspace \
    && chmod 1777 /workspace

WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
