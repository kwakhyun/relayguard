import ipaddress
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Client-meaningful upstream statuses that do not overlap with relay
# authentication (401), policy (403) or gateway budget (429) semantics.
ForwardableStatus = Literal[400, 404, 409, 410, 412, 422]


class RouteRule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(min_length=1, max_length=256)
    query_keys: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("path")
    @classmethod
    def canonical_path(cls, path):
        if path == "/":
            return path
        if not path.startswith("/"):
            raise ValueError("Path must start with /")
        for segment in path[1:].split("/"):
            if segment == "*":
                continue
            if segment in ("", ".", "..") or not re.fullmatch(r"[A-Za-z0-9._~-]+", segment):
                raise ValueError("Use literal ASCII path segments; * matches exactly one segment")
        return path

    @field_validator("query_keys")
    @classmethod
    def query_names(cls, keys):
        if len(set(keys)) != len(keys) or any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", k) for k in keys):
            raise ValueError("Query keys must be unique ASCII identifiers")
        return keys


class Policy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    routes: list[RouteRule] = Field(min_length=1, max_length=32)
    ip_allowlist: list[str] = Field(default_factory=list, max_length=32)
    requests_per_minute: int = Field(default=30, ge=1, le=10000)
    response_bytes_limit: int = Field(default=16384, ge=128, le=1048576)
    bytes_per_minute: int = Field(default=65536, ge=128, le=104857600)
    max_total_requests: int | None = Field(default=None, ge=1, le=1_000_000_000)
    max_total_bytes: int | None = Field(default=None, ge=128, le=1_000_000_000_000)
    # Upstream non-2xx bodies are always withheld.  These statuses may be
    # returned to the client as a bodiless gateway error instead of 502 so an
    # integration can tell "not found" from "provider unavailable".
    forward_error_statuses: list[ForwardableStatus] = Field(default_factory=list, max_length=6)

    @field_validator("forward_error_statuses")
    @classmethod
    def unique_statuses(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("Duplicate statuses")
        return sorted(values)

    @field_validator("ip_allowlist")
    @classmethod
    def cidrs(cls, values):
        try:
            result = [str(ipaddress.ip_network(v, strict=True)) for v in values]
        except ValueError as exc:
            raise ValueError("Use valid network CIDRs, e.g. 127.0.0.1/32") from exc
        if len(set(result)) != len(result):
            raise ValueError("Duplicate networks")
        return result

    @model_validator(mode="after")
    def unique_routes(self):
        routes = [(r.method, r.path) for r in self.routes]
        if len(set(routes)) != len(routes):
            raise ValueError("Duplicate routes")
        return self


class CredentialCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    ttl_hours: int = Field(default=24, ge=1, le=720)
    policy: Policy

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Name must be visible text")
        return value


class CredentialRotate(BaseModel):
    """Issue a replacement and shorten or end the current key in one transaction."""
    model_config = ConfigDict(extra="forbid", strict=True)
    credential: CredentialCreate
    grace_hours: int = Field(default=0, ge=0, le=168)


class PolicyCheckCase(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    method: str = Field(min_length=1, max_length=32, pattern=r"^[A-Z]+$")
    path: str = Field(min_length=1, max_length=2048)
    peer_ip: str | None = Field(default=None, min_length=1, max_length=45)

    @field_validator("peer_ip")
    @classmethod
    def numeric_peer(cls, value):
        if value is None:
            return value
        if "%" in value:
            raise ValueError("Scoped addresses are not supported")
        ipaddress.ip_address(value)
        return value


class PolicyCheck(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    policy: Policy
    cases: list[PolicyCheckCase] = Field(min_length=1, max_length=50)
