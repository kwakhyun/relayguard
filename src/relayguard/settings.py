from dataclasses import dataclass, field
import ipaddress
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


def secret_from_env(name):
    """Read one bounded secret source, including read-only container secrets."""
    value, filename = os.environ.get(name, ""), os.environ.get(name + "_FILE", "")
    if value and filename:
        raise ValueError(f"Set only {name} or {name}_FILE, not both")
    if not filename:
        return value
    try:
        path = Path(filename)
        if not path.is_file():
            raise ValueError("Secret source must be a regular file")
        with path.open("rb") as source:
            raw = source.read(8195)
        if raw.endswith(b"\r\n"):
            raw = raw[:-2]
        elif raw.endswith(b"\n"):
            raw = raw[:-1]
        if not raw or len(raw) > 8192:
            raise ValueError("Invalid secret length")
        return raw.decode("ascii")
    except (OSError, UnicodeError, ValueError):
        # Neither secret contents nor a potentially sensitive filename belongs in logs.
        raise ValueError(f"Cannot read a valid secret from {name}_FILE") from None


# Headers the gateway constructs itself or that change transport semantics.
_RESERVED_AUTH_HEADERS = frozenset({
    "accept", "accept-encoding", "connection", "content-length", "content-type", "cookie",
    "forwarded", "host", "keep-alive", "proxy-authorization", "proxy-connection", "te",
    "trailer", "transfer-encoding", "upgrade", "x-forwarded-for", "x-forwarded-host",
    "x-forwarded-proto", "x-real-ip",
})


def _check_origin_text(value, label):
    if (not value or any(c in value for c in "?#\\") or
            any(ord(c) < 33 or ord(c) > 126 for c in value)):
        raise ValueError(f"{label} must be printable ASCII without query or fragment delimiters")


def _check_hostname(hostname, label):
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        if any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", part)
               for part in hostname.split(".")):
            raise ValueError(f"Invalid {label} hostname") from None


def _is_loopback(hostname):
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return hostname == "localhost"


def env_number(name, default, parser):
    try:
        return parser(os.environ.get(name, str(default)))
    except ValueError:
        raise ValueError(f"Invalid numeric value for {name}") from None


def auth_scheme_from_env():
    """Default Bearer; "none" sends the raw token in the configured header."""
    value = os.environ.get("RELAYGUARD_UPSTREAM_AUTH_SCHEME", "Bearer")
    return "" if value.strip().lower() == "none" else value


@dataclass(frozen=True)
class Settings:
    upstream_url: str
    upstream_token: str = field(repr=False)
    admin_token: str = field(repr=False)
    database_path: str = ".relayguard/relayguard.db"
    demo_mode: bool = False
    max_request_bytes: int = 65536
    upstream_timeout_seconds: float = 5.0
    demo_gateway_url: str = "http://127.0.0.1:8810"
    # Optional second admin secret accepted during rotation.
    admin_token_next: str = field(default="", repr=False)
    # Optional read-only scrape secret for /metrics; the admin token also works.
    metrics_token: str = field(default="", repr=False)
    upstream_auth_header: str = "Authorization"
    # Prefix placed before the upstream token; "" sends the raw token value.
    upstream_auth_scheme: str = "Bearer"
    # Optional operator webhook for security and budget alerts.
    alert_webhook_url: str = field(default="", repr=False)
    alert_deny_threshold: int = 20
    alert_cooldown_seconds: int = 600

    def upstream_auth_value(self):
        return f"{self.upstream_auth_scheme} {self.upstream_token}" if self.upstream_auth_scheme else self.upstream_token

    def admin_tokens(self):
        return tuple(token for token in (self.admin_token, self.admin_token_next) if token)

    def __post_init__(self):
        if (not self.upstream_url or any(c in self.upstream_url for c in "?#\\") or
                any(ord(c) < 33 or ord(c) > 126 for c in self.upstream_url)):
            raise ValueError("Upstream origin must be printable ASCII without query or fragment delimiters")
        url = urlsplit(self.upstream_url)
        if (not url.hostname or url.username or url.password or url.query or url.fragment
                or url.path not in ("", "/")):
            raise ValueError("Upstream must be an origin without path, credentials, query or fragment")
        try:
            if url.port is not None and url.port == 0:
                raise ValueError("Port must be positive")
        except ValueError as exc:
            raise ValueError("Invalid upstream port") from exc
        try:
            ipaddress.ip_address(url.hostname)
        except ValueError:
            if any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                   for label in url.hostname.split(".")):
                raise ValueError("Invalid upstream hostname")
        if self.demo_mode:
            try:
                loopback = ipaddress.ip_address(url.hostname).is_loopback
            except ValueError:
                loopback = url.hostname == "localhost"
            if url.scheme != "http" or not loopback:
                raise ValueError("Demo upstream must be HTTP on loopback")
            gateway = urlsplit(self.demo_gateway_url)
            if (any(c in self.demo_gateway_url for c in "?#\\") or
                    any(ord(c) < 33 or ord(c) > 126 for c in self.demo_gateway_url) or
                    gateway.scheme != "http" or gateway.hostname != "127.0.0.1" or gateway.username
                    or gateway.password or gateway.path not in ("", "/") or gateway.query or gateway.fragment):
                raise ValueError("Demo gateway must be HTTP on 127.0.0.1")
            gateway.port
        elif url.scheme != "https":
            raise ValueError("Production upstream requires HTTPS")
        for name, token in (("admin", self.admin_token), ("upstream", self.upstream_token)):
            if not token or len(token) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in token):
                raise ValueError(f"Invalid {name} token")
        if len(self.admin_token) < 32:
            raise ValueError("Admin token requires at least 32 characters; use a random secret")
        if self.admin_token == self.upstream_token:
            raise ValueError("Admin and upstream tokens must be distinct")
        secrets_in_use = [self.admin_token, self.upstream_token]
        for name, token in (("next admin", self.admin_token_next), ("metrics", self.metrics_token)):
            if not token:
                continue
            if len(token) < 32 or len(token) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in token):
                raise ValueError(f"Invalid {name} token; use a random secret of at least 32 characters")
            if token in secrets_in_use:
                raise ValueError(f"The {name} token must differ from every other configured secret")
            secrets_in_use.append(token)
        if (not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}", self.upstream_auth_header)
                or self.upstream_auth_header.lower() in _RESERVED_AUTH_HEADERS):
            raise ValueError("Invalid upstream authentication header name")
        if self.upstream_auth_scheme and not re.fullmatch(r"[A-Za-z][A-Za-z0-9._~+/-]{0,31}", self.upstream_auth_scheme):
            raise ValueError("Invalid upstream authentication scheme")
        if self.alert_webhook_url:
            _check_origin_text(self.alert_webhook_url, "Alert webhook URL")
            hook = urlsplit(self.alert_webhook_url)
            if not hook.hostname or hook.username or hook.password or hook.query or hook.fragment:
                raise ValueError("Alert webhook must be a URL without credentials, query or fragment")
            _check_hostname(hook.hostname, "alert webhook")
            try:
                hook.port
            except ValueError:
                raise ValueError("Invalid alert webhook port") from None
            if hook.scheme != "https" and not (hook.scheme == "http" and _is_loopback(hook.hostname)):
                raise ValueError("Alert webhook requires HTTPS (HTTP is allowed only on loopback)")
        if not 1 <= self.alert_deny_threshold <= 100000:
            raise ValueError("Invalid alert deny threshold")
        if not 0 <= self.alert_cooldown_seconds <= 86400:
            raise ValueError("Invalid alert cooldown")
        if not 1 <= self.max_request_bytes <= 1048576:
            raise ValueError("Invalid request byte limit")
        if not 0.1 <= self.upstream_timeout_seconds <= 60:
            raise ValueError("Invalid upstream timeout")

    @classmethod
    def from_env(cls):
        return cls(
            upstream_url=os.environ.get("RELAYGUARD_UPSTREAM_URL", ""),
            upstream_token=secret_from_env("RELAYGUARD_UPSTREAM_TOKEN"),
            admin_token=secret_from_env("RELAYGUARD_ADMIN_TOKEN"),
            database_path=os.environ.get("RELAYGUARD_DB", ".relayguard/relayguard.db"),
            max_request_bytes=env_number("RELAYGUARD_MAX_REQUEST_BYTES", 65536, int),
            upstream_timeout_seconds=env_number("RELAYGUARD_UPSTREAM_TIMEOUT_SECONDS", 5.0, float),
            admin_token_next=secret_from_env("RELAYGUARD_ADMIN_TOKEN_NEXT"),
            metrics_token=secret_from_env("RELAYGUARD_METRICS_TOKEN"),
            upstream_auth_header=os.environ.get("RELAYGUARD_UPSTREAM_AUTH_HEADER", "Authorization"),
            upstream_auth_scheme=auth_scheme_from_env(),
            alert_webhook_url=secret_from_env("RELAYGUARD_ALERT_WEBHOOK_URL"),
            alert_deny_threshold=env_number("RELAYGUARD_ALERT_DENY_THRESHOLD", 20, int),
            alert_cooldown_seconds=env_number("RELAYGUARD_ALERT_COOLDOWN_SECONDS", 600, int),
        )
