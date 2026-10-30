"""Offline validation of credential policies and expected request decisions.

This deliberately stops before authentication, request headers, live budgets,
storage and upstream execution. Only the gateway's static request rules run.
"""

from __future__ import annotations

import ipaddress
import json
from pathlib import Path
from typing import Literal
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .gateway import canonical_path, match_rule, parse_query, peer_allowed
from .models import CredentialCreate, Policy


_POLICY_LIMIT = 65536
_CASES_LIMIT = 8 * 1024 * 1024
_FIELDS = frozenset({
    "name", "ttl_hours", "policy", "routes", "method", "path", "query_keys",
    "ip_allowlist", "requests_per_minute", "response_bytes_limit",
    "bytes_per_minute", "max_total_requests", "max_total_bytes", "cases", "peer_ip", "expected",
})


class RequestCase(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=80)
    method: str = Field(min_length=1, max_length=32, pattern=r"^[A-Z]+$")
    path: str = Field(min_length=1, max_length=8192)
    peer_ip: str = Field(min_length=1, max_length=45)
    expected: Literal["allow", "deny"]

    @field_validator("name")
    @classmethod
    def visible_name(cls, value):
        value = value.strip()
        if not value or any(unicodedata.category(char).startswith("C") for char in value):
            raise ValueError("Use a visible case label")
        return value

    @field_validator("peer_ip")
    @classmethod
    def numeric_peer(cls, value):
        if "%" in value:
            raise ValueError("Scoped addresses are not supported")
        ipaddress.ip_address(value)
        return value


class CaseFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    cases: list[RequestCase] = Field(min_length=1, max_length=1000)


class InputError(Exception):
    def __init__(self, source, code, fields=None):
        self.source = source
        self.code = code
        self.fields = fields or []


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("JSON requires finite numbers")


def _read_json(path, source, limit):
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(limit + 1)
    except (OSError, ValueError, TypeError):
        raise InputError(source, "file_unreadable") from None
    if len(raw) > limit:
        raise InputError(source, "file_too_large")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                          parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise InputError(source, "invalid_json") from None


def _validate(model, data, source):
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        # Pydantic's normal error text includes rejected values. Do not echo
        # raw queries, tokens, file paths or unknown JSON property names.
        fields = [{
            "field": ".".join(str(part) if isinstance(part, int) or part in _FIELDS
                              else "[field]" for part in error["loc"]) or "$",
            "code": error["type"],
        } for error in exc.errors(include_input=False, include_context=False,
                                  include_url=False)[:20]]
        raise InputError(source, "invalid_schema", fields) from None


def evaluate(policy: Policy, case: RequestCase) -> dict:
    """Evaluate in the same order as proxy_request, without reserving a call."""
    raw_path, _, raw_query = case.path.partition("?")
    path = None
    if raw_path.startswith("/"):
        try:
            path = canonical_path(("/proxy" + raw_path).encode("ascii"), raw_path[1:])
        except UnicodeEncodeError:
            pass
    rule = None
    if path is None:
        code = "invalid_path"
    else:
        rule = match_rule(case.method, path, policy.routes)
        if rule is None:
            code = "route_denied"
        elif not peer_allowed(case.peer_ip, policy.ip_allowlist):
            code = "ip_denied"
        else:
            # Keep the original bytes: urlsplit/unquote would hide ambiguous
            # spelling that the running gateway rejects.
            try:
                query = raw_query.encode("utf-8")
            except UnicodeEncodeError:
                query = b"\xff"
            code = "allowed" if parse_query(query, rule.query_keys) is not None else "query_denied"
    decision = "allow" if code == "allowed" else "deny"
    return {
        "name": case.name,
        "decision": decision,
        "code": code,
        "matched_route": {"method": rule.method, "path": rule.path} if rule else None,
        "expected": case.expected,
        "passed": decision == case.expected,
    }


def run(policy_path: str, cases_path: str | None = None) -> int:
    """Print one JSON result; return 0 for success, 1 for invalid input/mismatch."""
    try:
        credential = _validate(CredentialCreate,
                               _read_json(policy_path, "policy", _POLICY_LIMIT), "policy")
        cases = []
        if cases_path is not None:
            cases = _validate(CaseFile,
                              _read_json(cases_path, "cases", _CASES_LIMIT), "cases").cases
        results = [evaluate(credential.policy, case) for case in cases]
        passed = all(result["passed"] for result in results)
        output = {
            "valid": True, "passed": passed, "scope": "static_request_policy",
            "cases_checked": len(results), "results": results,
        }
    except InputError as exc:
        passed = False
        output = {
            "valid": False, "passed": False, "scope": "static_request_policy",
            "error": {"source": exc.source, "code": exc.code, "fields": exc.fields},
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if passed else 1
