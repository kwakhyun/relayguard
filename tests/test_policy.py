"""Boundary cases for canonical capabilities, without contacting any server."""

import pytest

from relayguard.gateway import canonical_path, match_rule, parse_query, peer_allowed
from relayguard.models import RouteRule


@pytest.mark.parametrize("path", ["", "customers", "customers/customer_1", "v1.2/item~1"])
def test_canonical_paths(path):
    assert canonical_path(("/proxy/" + path).encode(), path) == "/" + path


@pytest.mark.parametrize("path", [
    "/customers", "customers/", "customers//1", "customers/../admin",
    "customers/./1", "customers/%2e%2e/admin", "customers/%252e%252e/admin",
    "customers\\admin", "customers/*", "고객", "customers/1?admin=true",
    "customers/1#fragment", "x" * 256,
])
def test_normalization_aliases_are_rejected(path):
    assert canonical_path(("/proxy/" + path).encode(), path) is None


def test_raw_path_is_authoritative():
    assert canonical_path(b"/proxy/customers/%31", "customers/1") is None
    assert canonical_path(b"/proxy/customers%2F1", "customers/1") is None
    assert canonical_path(b"/other/customers/1", "customers/1") is None


def test_wildcard_matches_exactly_one_segment_and_method():
    rule = RouteRule(method="GET", path="/customers/*")
    assert match_rule("GET", "/customers/1", [rule]) == rule
    for path in ["/customers", "/customers/", "/customers/1/private", "/customersX/1"]:
        assert match_rule("GET", path, [rule]) is None
    assert match_rule("DELETE", "/customers/1", [rule]) is None


def test_specific_rule_does_not_inherit_wildcard_query_permission():
    broad = RouteRule(method="GET", path="/customers/*", query_keys=["expand"])
    exact = RouteRule(method="GET", path="/customers/me")
    chosen = match_rule("GET", "/customers/me", [broad, exact])
    assert chosen == exact
    assert parse_query(b"expand=private", chosen.query_keys) is None


def test_empty_query_and_valid_utf8_values():
    assert parse_query(b"", []) == []
    assert parse_query(b"q=%ED%95%9C%EA%B8%80&limit=10", ["q", "limit"]) == [("q", "한글"), ("limit", "10")]
    assert parse_query(b"q=", ["q"]) == [("q", "")]
    assert parse_query(b"q=one+two%26three", ["q"]) == [("q", "one two&three")]


@pytest.mark.parametrize("query", [
    b"q=1&q=2", b"q=1&admin=1", b"%71=1", b"q=1;%71=2", b"q",
    b"q=%", b"q=%0g", b"q=%FF", b"q=%00", b"q=%0d%0a", b"q=%7f",
    b"q=%E2%80%AEhidden", b"q=has space", b"q=x#fragment", b"q=1&",
    b"q=" + b"x" * 513, b"q=" + b"x" * 2049,
])
def test_ambiguous_unsafe_or_oversized_queries_are_rejected(query):
    assert parse_query(query, ["q"]) is None


def test_peer_networks_use_actual_numeric_address():
    assert peer_allowed("127.0.0.1", ["127.0.0.0/8"])
    assert peer_allowed("::ffff:127.0.0.1", ["127.0.0.1/32"])
    assert peer_allowed("2001:db8::1", ["2001:db8::/32"])
    assert not peer_allowed("203.0.113.4", ["127.0.0.1/32"])
    assert not peer_allowed("localhost", ["127.0.0.1/32"])
    assert not peer_allowed("fe80::1%lo0", ["fe80::/10"])
    assert not peer_allowed(None, ["0.0.0.0/0"])
    assert peer_allowed(None, [])
