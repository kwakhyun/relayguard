"""Configuration validation prevents ambiguous routes and unsafe upstreams."""
import pytest
from pydantic import ValidationError

from relayguard.models import CredentialCreate, Policy, RouteRule
from relayguard.settings import Settings


def route(**overrides):
    return RouteRule(**{"method": "GET", "path": "/customers", **overrides})


def policy(**overrides):
    return Policy(**{"routes": [route()], **overrides})


@pytest.mark.parametrize("path", [
    "customers", "//customers", "/customers/", "/./customers", "/customers/../export",
    "/customers/%2e%2e/export", "/customers/%2fexport", "/customers\\export",
    "/customers;admin", "/customers?all=true", "/customers#export", "/customers/**",
    "/customers/user*", "/고객", "/customers/\n", "/customers/\x00",
])
def test_ambiguous_or_unsafe_policy_paths_are_rejected(path):
    with pytest.raises(ValidationError):
        route(path=path)


@pytest.mark.parametrize("path", ["/", "/customers", "/v1/customers/*", "/v1/customer-1.json"])
def test_literal_ascii_paths_and_single_segment_wildcard_are_supported(path):
    assert route(path=path).path == path


@pytest.mark.parametrize("keys", [
    ["limit", "limit"], [""], ["1limit"], ["filter[]"], ["filter.name"],
    ["api-key"], ["limit\n"], ["한도"], ["x" * 65],
])
def test_ambiguous_query_names_are_rejected(keys):
    with pytest.raises(ValidationError):
        route(query_keys=keys)


def test_query_keys_are_explicit_and_can_be_empty():
    assert route().query_keys == []
    assert route(query_keys=["limit", "after_id"]).query_keys == ["limit", "after_id"]


@pytest.mark.parametrize("networks", [
    ["127.0.0.1/24"], ["192.0.2.0/33"], ["localhost"], ["https://example.com"],
    ["192.0.2.0/24", "192.0.2.0/24"], ["2001:db8::1/64"], ["::/129"],
])
def test_malformed_or_duplicate_cidrs_are_rejected(networks):
    with pytest.raises(ValidationError):
        policy(ip_allowlist=networks)


def test_cidr_canonicalization_and_ipv6():
    assert policy(ip_allowlist=["127.0.0.1/32", "2001:0db8::/64"]).ip_allowlist == [
        "127.0.0.1/32", "2001:db8::/64",
    ]


@pytest.mark.parametrize("overrides", [
    {"requests_per_minute": 0}, {"requests_per_minute": True}, {"requests_per_minute": "30"},
    {"response_bytes_limit": 0}, {"bytes_per_minute": -1}, {"routes": []},
    {"routes": [route(), route()]}, {"unexpected": "allow"},
])
def test_policies_reject_permissive_type_coercion_and_invalid_limits(overrides):
    with pytest.raises(ValidationError):
        policy(**overrides)


@pytest.mark.parametrize("overrides", [
    {"name": "   "}, {"name": "line\nbreak"}, {"name": "\x7f"},
    {"ttl_hours": 0}, {"ttl_hours": 721}, {"ttl_hours": True}, {"unexpected": "field"},
])
def test_credential_metadata_and_lifetime_are_bounded(overrides):
    with pytest.raises(ValidationError):
        CredentialCreate(**{"name": "CRM", "policy": policy(), **overrides})


def settings(**overrides):
    return Settings(**{
        "upstream_url": "https://api.example.test", "upstream_token": "provider-test-secret",
        "admin_token": "admin-" + "a" * 40, **overrides,
    })


@pytest.mark.parametrize("url", [
    "http://api.example.test", "ftp://api.example.test", "//api.example.test", "https://",
    "https://user:password@api.example.test", "https://api.example.test/path",
    "https://api.example.test?token=secret", "https://api.example.test#fragment",
    "https://api.example.test:99999", "https://api.example.test:invalid",
])
def test_production_requires_a_fixed_https_origin(url):
    with pytest.raises(ValueError):
        settings(upstream_url=url)


@pytest.mark.parametrize("url", ["http://127.0.0.1:8811", "http://[::1]:8811", "http://localhost:8811"])
def test_demo_http_is_limited_to_loopback(url):
    assert settings(upstream_url=url, demo_mode=True).upstream_url == url


@pytest.mark.parametrize("url", ["http://192.0.2.1", "http://api.example.test", "https://127.0.0.1"])
def test_demo_mode_rejects_nonlocal_or_unexpected_upstream_schemes(url):
    with pytest.raises(ValueError):
        settings(upstream_url=url, demo_mode=True)


@pytest.mark.parametrize("overrides", [
    {"admin_token": "short"}, {"admin_token": ""}, {"upstream_token": ""},
    {"admin_token": "a" * 32 + "\n"}, {"upstream_token": "abc\r\nX-Evil: true"},
    {"upstream_token": "with space"}, {"upstream_token": "é"},
    {"upstream_token": "admin-" + "a" * 40},
    {"max_request_bytes": 0}, {"max_request_bytes": 1048577},
    {"upstream_timeout_seconds": 0}, {"upstream_timeout_seconds": 61},
])
def test_settings_reject_bad_secrets_and_unbounded_resources(overrides):
    with pytest.raises(ValueError):
        settings(**overrides)


def test_settings_repr_does_not_expose_secrets():
    configured = settings()
    representation = repr(configured)
    assert configured.admin_token not in representation
    assert configured.upstream_token not in representation
