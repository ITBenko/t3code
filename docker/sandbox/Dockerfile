# Reference image for T3 Code local Docker sandboxes.
#
#   docker build -t t3-sandbox:local docker/sandbox
#   T3CODE_DOCKER_SANDBOX_IMAGE=t3-sandbox:local npx t3
#
# Any image satisfying the contract in docs/user/local-docker-sandboxes.md works;
# this one is the worked example, and what the feature is tested against.

# `t3` builds node-pty from source, so the install needs a toolchain the runtime
# has no use for. Build it here and copy the result across.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# A sandbox can only run a provider whose CLI is present, whatever credentials
# it is given. Add the ones you intend to use.
ARG T3_VERSION=latest
RUN npm install -g --omit=dev \
    "t3@${T3_VERSION}" \
    @openai/codex \
    @anthropic-ai/claude-code \
    opencode-ai \
  && npm cache clean --force

FROM node:22-bookworm-slim

# git and tar carry the workspace copy: the managing server sends a tar of the
# project's HEAD tree and the sandbox extracts and commits it.
# coreutils provides `timeout`, which bounds credential and pairing commands.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    coreutils \
    git \
    tar \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin /usr/local/bin

# T3 Code mounts private volumes at these three paths. Docker creates a mount
# point that the image lacks as root-owned, which the non-root user below could
# then never write to — so they are created and owned here, before the mount.
RUN useradd --create-home --uid 10001 --user-group agent \
  && mkdir -p /workspace /t3-data /t3-home \
  && chown -R 10001:10001 /workspace /t3-data /t3-home

# The manager refuses an image that would run as root.
USER 10001:10001
ENV HOME=/t3-home
ENV T3CODE_HOME=/t3-data
WORKDIR /workspace
