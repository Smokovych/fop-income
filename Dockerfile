FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app ./app
COPY docs ./docs
COPY run.py ./

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Europe/Kyiv

# Дані (SQLite) — у томі /data (на Railway — Volume з точкою монтування /data). Процес працює від root, бо хмарні томи (Railway тощо)
# монтуються з правами root; у контейнері немає нічого, крім цієї програми.
RUN mkdir -p /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/me')"

CMD ["python", "run.py"]
