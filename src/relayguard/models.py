import ipaddress
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
