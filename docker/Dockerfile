# AntiBrow SDK on Debian slim.
#
# The image ships the Python SDK and every shared library the browser engine links
# against, plus xvfb: the engine is a real Chromium fork, not a headless build, so it
# needs a display even when nobody is looking at it (a headless Chromium has its own
# detectable fingerprint, which is the thing this browser exists to avoid).
#
# xauth is not optional: without it `xvfb-run` exits with 「xauth command not found」
# before the browser is ever reached.
#
# The engine itself is NOT baked in. It downloads on first launch into ANTIBROW_CACHE_DIR
# and is cached there, so mount that path as a volume to keep it across containers.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    ANTIBROW_CACHE_DIR=/opt/antibrow

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG ANTIBROW_VERSION=
RUN pip install --no-cache-dir "antibrow${ANTIBROW_VERSION:+==$ANTIBROW_VERSION}"

WORKDIR /work

# Anything you pass runs under a virtual display. With no arguments the image prints
# the SDK and engine versions, which is also its own smoke test.
#
# The `sh -c` wrapper is not decoration: with `ENTRYPOINT ["xvfb-run", "-a"]`, xvfb-run
# becomes PID 1, and as PID 1 it never reaps the browser's children - the container then
# hangs after a successful launch with no output at all. Keeping a shell as PID 1 fixes it.
ENTRYPOINT ["sh", "-c", "xvfb-run -a \"$0\" \"$@\""]
CMD ["python", "-m", "antibrow", "version"]
