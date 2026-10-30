FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app ./app
COPY static ./static
COPY run.py ./

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Europe/Kyiv

RUN useradd -r -u 1000 fop && mkdir -p /data && chown fop /data
USER fop
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/me')"

CMD ["python", "run.py"]
