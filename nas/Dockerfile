FROM python:3.12-slim-bookworm

# NAS 无法直连 deb.debian.org；仅在镜像内换源，保留 Debian 的签名校验。
RUN sed -i 's|http://deb.debian.org/debian-security|https://security.debian.org/debian-security|g; s|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/hongguo-requirements.txt
RUN pip install --no-cache-dir -r /tmp/hongguo-requirements.txt \
    && rm /tmp/hongguo-requirements.txt

COPY run /app/run
COPY *.py /app/run/app/
COPY web /app/run/app/web
WORKDIR /app/run/app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/run/app/frida:/app/run/app
CMD ["python", "nas_server.py"]
