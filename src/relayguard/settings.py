from dataclasses import dataclass, field
import ipaddress
import os
import re
from urllib.parse import urlsplit


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
        if not 1 <= self.max_request_bytes <= 1048576:
            raise ValueError("Invalid request byte limit")
        if not 0.1 <= self.upstream_timeout_seconds <= 60:
            raise ValueError("Invalid upstream timeout")

    @classmethod
    def from_env(cls):
        return cls(
            upstream_url=os.environ.get("RELAYGUARD_UPSTREAM_URL", ""),
            upstream_token=os.environ.get("RELAYGUARD_UPSTREAM_TOKEN", ""),
            admin_token=os.environ.get("RELAYGUARD_ADMIN_TOKEN", ""),
            database_path=os.environ.get("RELAYGUARD_DB", ".relayguard/relayguard.db"),
        )
