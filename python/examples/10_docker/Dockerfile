# Minimal antibrow image: pip install from PyPI, run headful under Xvfb.
#
#   cd examples/10_docker
#   docker build -t antibrow-demo .
#   docker run --rm -e ANTIBROW_API_KEY=$ANTIBROW_API_KEY \
#     -v antibrow-cache:/root/.anti-detect-browser antibrow-demo
#
# The volume keeps the kernel (~440 MB extracted) and profiles across runs. It
# is downloaded at run time, by you, from AntiBrow's CDN - do not bake it into
# an image you publish (see BINARY-LICENSE.md).

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 ANTIBROW_CACHE_DIR=/root/.anti-detect-browser

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb ca-certificates fonts-liberation fonts-dejavu-core \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
        libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
        libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
        libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir antibrow

WORKDIR /app
COPY scrape.py .

ENTRYPOINT ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24"]
CMD ["python", "scrape.py"]
