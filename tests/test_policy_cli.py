import json
from pathlib import Path
import socket
import sqlite3

import pytest

from relayguard.models import CredentialCreate
from relayguard.policy_cli import RequestCase, evaluate, run


def credential(**policy_overrides):
    return {
        "name": "Synthetic policy", "ttl_hours": 24,
        "policy": {
            "routes": [{"method": "GET", "path": "/customers", "query_keys": ["limit"]}],
            "ip_allowlist": ["127.0.0.1/32", "::1/128"],
            **policy_overrides,
        },
    }


def case(**overrides):
    return {
        "name": "synthetic request", "method": "GET", "path": "/customers?limit=2",
        "peer_ip": "127.0.0.1", "expected": "allow", **overrides,
    }


def write_json(tmp_path, name, value):
    path = tmp_path / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return str(path)


def result(capsys):
    captured = capsys.readouterr()
    assert not captured.err
    return json.loads(captured.out)


def test_validate_credential_schema_without_server_secrets_or_database(tmp_path, capsys, monkeypatch):
    policy_path = write_json(tmp_path, "policy.json", credential())

    def forbidden(*args, **kwargs):
        raise AssertionError("Offline check attempted network or database I/O")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    for variable in ("RELAYGUARD_UPSTREAM_URL", "RELAYGUARD_UPSTREAM_TOKEN", "RELAYGUARD_ADMIN_TOKEN"):
        monkeypatch.delenv(variable, raising=False)
    assert run(policy_path) == 0
    assert result(capsys) == {
        "valid": True, "passed": True, "scope": "static_request_policy",
        "cases_checked": 0, "results": [],
    }


@pytest.mark.parametrize("overrides,code", [
    ({}, "allowed"),
    ({"path": "/customers?limit=999999"}, "allowed"),
    ({"peer_ip": "::ffff:127.0.0.1"}, "allowed"),
    ({"method": "POST"}, "route_denied"),
    ({"method": "HEAD"}, "route_denied"),
    ({"path": "/exports"}, "route_denied"),
    ({"path": "customers"}, "invalid_path"),
    ({"path": "https://api.example.test/customers"}, "invalid_path"),
    ({"path": "/%63ustomers"}, "invalid_path"),
    ({"path": "/customers%2fprivate"}, "invalid_path"),
    ({"path": "/customers/../exports"}, "invalid_path"),
    ({"path": "/customers//private"}, "invalid_path"),
    ({"path": "/customers/"}, "invalid_path"),
    ({"path": "/고객"}, "invalid_path"),
    ({"path": "/customers?limit=2&limit=3"}, "query_denied"),
    ({"path": "/customers?%6cimit=2"}, "query_denied"),
    ({"path": "/customers?limit=%"}, "query_denied"),
    ({"path": "/customers?limit=%FF"}, "query_denied"),
    ({"path": "/customers?limit=%00"}, "query_denied"),
    ({"path": "/customers?limit=2#fragment"}, "query_denied"),
    ({"path": "/customers?limit=한글"}, "query_denied"),
    ({"path": "/customers?limit=%ED%95%9C%EA%B8%80"}, "allowed"),
    ({"path": "/customers?limit=" + "x" * 513}, "query_denied"),
    ({"path": "/customers?limit=" + "x" * 2049}, "query_denied"),
    ({"peer_ip": "203.0.113.9"}, "ip_denied"),
    ({"peer_ip": "203.0.113.9", "path": "/customers?unknown=2"}, "ip_denied"),
])
def test_static_decisions_and_gateway_evaluation_order(overrides, code):
    policy = CredentialCreate.model_validate(credential()).policy
    expected = "allow" if code == "allowed" else "deny"
    checked = evaluate(policy, RequestCase.model_validate(case(**{**overrides, "expected": expected})))
    assert checked["code"] == code
    assert checked["decision"] == expected
    assert checked["passed"]
    assert checked["matched_route"] == (None if code in {"invalid_path", "route_denied"}
                                        else {"method": "GET", "path": "/customers"})


def test_specific_route_does_not_inherit_query_permissions_and_only_template_is_output():
    policy = CredentialCreate.model_validate(credential(routes=[
        {"method": "GET", "path": "/customers/*", "query_keys": ["limit"]},
        {"method": "GET", "path": "/customers/me", "query_keys": []},
    ])).policy
    denied = evaluate(policy, RequestCase.model_validate(case(path="/customers/me?limit=2", expected="deny")))
    assert denied["code"] == "query_denied"
    assert denied["matched_route"]["path"] == "/customers/me"
    allowed = evaluate(policy, RequestCase.model_validate(case(path="/customers/private-person?limit=secret-value")))
    assert allowed["passed"]
    assert allowed["matched_route"]["path"] == "/customers/*"
    assert "private-person" not in json.dumps(allowed)
    assert "secret-value" not in json.dumps(allowed)
    assert "127.0.0.1" not in json.dumps(allowed)


def test_cases_report_mismatch_as_nonzero_without_making_schema_invalid(tmp_path, capsys):
    policy_path = write_json(tmp_path, "policy.json", credential())
    cases_path = write_json(tmp_path, "cases.json", {"cases": [case(), case(name="wrong expectation", expected="deny")]})
    assert run(policy_path, cases_path) == 1
    output = result(capsys)
    assert output["valid"] and not output["passed"]
    assert output["cases_checked"] == 2
    assert [item["passed"] for item in output["results"]] == [True, False]


@pytest.mark.parametrize("data", [
    {}, {"cases": []}, {"cases": [case()] * 1001},
    {"cases": [{key: value for key, value in case().items() if key != "peer_ip"}]},
    {"cases": [case(expected=True)]}, {"cases": [case(path=42)]},
    {"cases": [case(method="get")]}, {"cases": [case(peer_ip="localhost")]},
    {"cases": [case(peer_ip="fe80::1%lo0")]}, {"cases": [case(name="\ud800")]},
    {"cases": [case(name="unsafe\nlabel")]}, {"cases": [case(secret_field="secret-value")]},
    {"cases": [case()], "private-secret-key": "secret-value"},
])
def test_strict_case_schema_does_not_echo_rejected_values(tmp_path, capsys, data):
    policy_path = write_json(tmp_path, "policy.json", credential())
    cases_path = write_json(tmp_path, "cases.json", data)
    assert run(policy_path, cases_path) == 1
    output = result(capsys)
    assert output["error"]["source"] == "cases"
    assert output["error"]["code"] == "invalid_schema"
    assert "secret-value" not in json.dumps(output)
    assert "private-secret-key" not in json.dumps(output)


def test_cases_upper_bound_is_inclusive(tmp_path, capsys):
    policy_path = write_json(tmp_path, "policy.json", credential())
    cases_path = write_json(tmp_path, "cases.json", {"cases": [case()] * 1000})
    assert run(policy_path, cases_path) == 0
    assert result(capsys)["cases_checked"] == 1000


@pytest.mark.parametrize("data", [
    credential()["policy"], credential(ttl_hours="24"),
    {**credential(), "ttl_hours": "24"},
    {**credential(), "policy": {"routes": []}},
    {**credential(), "private-secret-key": "secret-value"},
])
def test_only_the_real_issuer_schema_is_accepted(tmp_path, capsys, data):
    assert run(write_json(tmp_path, "policy.json", data)) == 1
    output = result(capsys)
    assert output["error"]["source"] == "policy"
    assert output["error"]["code"] == "invalid_schema"
    assert "secret-value" not in json.dumps(output)
    assert "private-secret-key" not in json.dumps(output)


@pytest.mark.parametrize("raw", [b"{not-json", b"\xff", b'{"name":"first","name":"second"}',
                                  b'{"ttl_hours":NaN}', b'{"ttl_hours":Infinity}', b"[" * 2000])
def test_invalid_json_is_a_clean_structured_error(tmp_path, capsys, raw):
    path = tmp_path / "policy.json"
    path.write_bytes(raw)
    assert run(str(path)) == 1
    assert result(capsys)["error"]["code"] == "invalid_json"


def test_missing_file_does_not_echo_local_paths(tmp_path, capsys):
    assert run(str(tmp_path / "private-filename.json")) == 1
    output = result(capsys)
    assert output["error"]["code"] == "file_unreadable"
    assert str(tmp_path) not in json.dumps(output)
    assert "private-filename" not in json.dumps(output)


@pytest.mark.parametrize("source,limit", [("policy", 65536), ("cases", 8 * 1024 * 1024)])
def test_oversized_input_is_rejected_before_json_parsing(tmp_path, capsys, source, limit):
    policy_path = write_json(tmp_path, "policy.json", credential())
    big = tmp_path / "big.json"
    big.write_bytes(b" " * (limit + 1))
    args = (str(big),) if source == "policy" else (policy_path, str(big))
    assert run(*args) == 1
    output = result(capsys)
    assert output["error"] == {"source": source, "code": "file_too_large", "fields": []}


def test_shipped_examples_pass_together(capsys):
    root = Path(__file__).resolve().parents[1]
    assert run(str(root / "examples/read-only-policy.json"), str(root / "examples/policy-cases.json")) == 0
    output = result(capsys)
    assert output["passed"] and output["cases_checked"] >= 8
