# AntiBrow on Linux, headful under Xvfb.
#
# Real headless Chromium carries its own detectable fingerprint, so this image
# renders to a virtual display instead of using --headless. The kernel itself is
# NOT baked into the image: it is downloaded on first launch, by you, from
# AntiBrow's CDN (see BINARY-LICENSE.md - baking it in and publishing the image
# would be redistribution).
#
#   docker build -t antibrow-example .
#   docker run --rm -e ANTIBROW_API_KEY=$ANTIBROW_API_KEY \
#     -v antibrow-cache:/root/.anti-detect-browser antibrow-example
#
# The named volume keeps the kernel (~440 MB extracted) and your profiles
# between runs - without it every container start re-downloads it.

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ANTIBROW_CACHE_DIR=/root/.anti-detect-browser

# Chromium's runtime dependencies plus Xvfb. Fonts matter for fingerprinting:
# a machine with no fonts at all is its own signal.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        ca-certificates \
        fonts-liberation \
        fonts-dejavu-core \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the SDK. Swap for `pip install antibrow` to pull the published wheel.
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install .

COPY examples ./examples

# xvfb-run gives the kernel a real (virtual) display, so it runs headful.
ENTRYPOINT ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24"]
CMD ["python", "examples/01_basic.py"]
