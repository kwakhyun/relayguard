FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
LABEL org.opencontainers.image.title="RelayGuard" \
      org.opencontainers.image.description="Scoped credential gateway for HTTP integrations" \
      org.opencontainers.image.source="https://github.com/kwakhyun/relayguard" \
      org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.lock .
RUN python -m pip install --no-cache-dir -r requirements.lock
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN python -m pip install --no-cache-dir --no-deps --no-build-isolation . \
    && groupadd --gid 10001 relayguard \
    && useradd --system --uid 10001 --gid 10001 --no-create-home relayguard \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
USER 10001:10001
ENV RELAYGUARD_DB=/data/relayguard.db
EXPOSE 8810
CMD ["relayguard", "serve", "--host", "0.0.0.0", "--port", "8810"]
