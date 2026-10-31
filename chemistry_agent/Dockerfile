ARG PYTHON_BASE_IMAGE=python:3.11-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CHEMISTRY_HOST=0.0.0.0 \
    CHEMISTRY_PORT=8765 \
    CHEMISTRY_AUTH_ENABLED=true \
    CHEMISTRY_COOKIE_SECURE=true \
    CHEMISTRY_DATABASE_PATH=/data/agent.sqlite3 \
    CHEMISTRY_TOKENIZER_PATH=/opt/chemistry/deepseek-tokenizer.json

RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 chemistry \
    && useradd --uid 10001 --gid chemistry --no-create-home chemistry \
    && mkdir -p /data /opt/chemistry \
    && chown chemistry:chemistry /data

WORKDIR /app
COPY pyproject.toml constraints.txt ./
RUN python -c "import subprocess,sys,tomllib; project=tomllib.load(open('pyproject.toml','rb')); subprocess.check_call([sys.executable,'-m','pip','install','--no-cache-dir','-c','constraints.txt',*project['project']['dependencies']])"
COPY README.md LICENSE ./
COPY src ./src
RUN python -m pip install --no-cache-dir --no-deps .
COPY scripts/setup_tokenizer.py ./scripts/setup_tokenizer.py
RUN python scripts/setup_tokenizer.py --output /opt/chemistry/deepseek-tokenizer.json

USER 10001:10001
EXPOSE 8765
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)"
CMD ["python", "-m", "chemistry_agent"]
