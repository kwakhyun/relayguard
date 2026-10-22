FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.lock .
RUN python -m pip install --no-cache-dir -r requirements.lock
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN python -m pip install --no-cache-dir --no-deps --no-build-isolation . \
    && useradd --system --uid 10001 relayguard \
    && mkdir /data && chown relayguard /data
USER 10001:10001
ENV RELAYGUARD_DB=/data/relayguard.db
EXPOSE 8810
CMD ["relayguard", "serve", "--host", "0.0.0.0", "--port", "8810"]
