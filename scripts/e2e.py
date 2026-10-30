"""Start two real loopback servers, exercise policy failures, then clean up.

Run from the repository root after installation. Stdlib only; no pytest or
browser required. Prints results without any credentials.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener

LOCAL_HTTP = build_opener(ProxyHandler({}))


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(base, path, token=None, post=False, *, payload=None, raw=False):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = b"" if post else None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    req = Request(base + path, data=data, headers=headers, method="POST" if post else "GET")
    try:
        with LOCAL_HTTP.open(req, timeout=30) as response:
            content = response.read()
            return response.status, content if raw else json.loads(content)
    except HTTPError as exc:
        content = exc.read()
        return exc.code, content if raw else json.loads(content)


def lifetime_checks(base, admin_token):
    """Exercise new allowances through the public HTTP API, with synthetic data."""
    issued, checks = [], []
    try:
        for limit, value, reason, expected_requests in (
            ("max_total_requests", 1, "lifetime_request_limit", 1),
            ("max_total_bytes", 128, "lifetime_byte_budget", 2),
        ):
            status, created = request(base, "/api/credentials", admin_token, post=True, payload={
                "name": "E2E: " + limit, "ttl_hours": 1,
                "policy": {"routes": [{"method": "GET", "path": "/payload"}],
                           "response_bytes_limit": 128, limit: value},
            })
            assert status == 201, "Lifetime credential creation failed"
            issued.append(created)
            assert created["credential"]["usage"] == {"total_requests": 0, "total_bytes": 0}
            status, content = request(base, "/proxy/payload", created["token"], raw=True)
            assert status == 200 and content == b"X" * 100, "First lifetime response was not allowed"
            checks.append({"name": limit + ": first response", "expected_status": 200,
                           "actual_status": status, "passed": True})
            status, content = request(base, "/proxy/payload", created["token"], raw=True)
            assert status == 429 and json.loads(content)["error"]["code"] == reason, "Lifetime limit was not enforced"
            assert b"X" * 100 not in content, "Rejected lifetime response leaked upstream data"
            checks.append({"name": limit + ": exhausted allowance", "expected_status": 429,
                           "actual_status": status, "passed": True, "reason": reason})

            status, listed = request(base, "/api/credentials", admin_token)
            assert status == 200, "Credential listing failed"
            visible = next(item for item in listed["items"] if item["id"] == created["credential"]["id"])
            assert visible["usage"] == {"total_requests": expected_requests, "total_bytes": 100}, "Public lifetime usage was incorrect"
            assert visible["policy"][limit] == value, "Lifetime limit was not persisted"
            assert created["token"] not in json.dumps(listed) and "secret_hash" not in json.dumps(listed), "Credential listing leaked secrets"
            checks.append({"name": limit + ": public usage", "passed": True,
                           "usage": visible["usage"]})

            status, audit = request(base, "/api/audit/export", admin_token)
            assert status == 200 and audit["verification"]["valid"], "Lifetime audit chain was invalid"
            encoded_audit = json.dumps(audit)
            assert admin_token not in encoded_audit and all(item["token"] not in encoded_audit for item in issued), "Audit leaked credentials"
            events = [event for event in audit["events"]
                      if event["credential_id"] == created["credential"]["id"] and event["kind"] == "proxy"]
            assert [(event["reason"], event["status"], event["response_bytes"]) for event in events] == [
                ("forwarded", 200, 100), (reason, 429, 0),
            ], "Lifetime decisions were not durably audited"
            checks.append({"name": limit + ": audit evidence", "passed": True})
        return checks
    finally:
        for created in issued:
            status, _ = request(base, "/api/credentials/" + created["credential"]["id"] + "/revoke", admin_token, post=True)
            assert status == 200, "Synthetic lifetime credential cleanup failed"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", help="Optional path for non-secret JSON test results")
    args = parser.parse_args()
    gateway_port, upstream_port = available_port(), available_port()
    while upstream_port == gateway_port:
        upstream_port = available_port()
    base = f"http://127.0.0.1:{gateway_port}"
    with tempfile.TemporaryDirectory(prefix="relayguard-e2e-") as directory:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        proc = subprocess.Popen([sys.executable, "-m", "relayguard", "demo", "--port", str(gateway_port),
            "--upstream-port", str(upstream_port), "--db", str(Path(directory) / "state.db")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        lines = queue.Queue()
        def read():
            for line in proc.stdout:
                lines.put(line.rstrip())
        threading.Thread(target=read, daemon=True).start()
        token = None
        next_is_token = False
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline:
                try:
                    line = lines.get(timeout=0.2)
                except queue.Empty:
                    if proc.poll() is not None:
                        raise RuntimeError("Demo server exited before readiness")
                    continue
                if next_is_token:
                    token = line
                    break
                next_is_token = line.startswith("Admin token (")
            if not token:
                raise RuntimeError("Demo startup timed out")
            while time.monotonic() < deadline:
                try:
                    status, _ = request(base, "/healthz")
                    if status == 200:
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Gateway readiness timed out")
            status, ready = request(base, "/readyz")
            assert status == 200 and ready == {"status": "ready", "service": "relayguard"}, "Storage readiness failed"
            status, result = request(base, "/api/demo/run", token, post=True)
            assert status == 200, f"Scenario endpoint returned {status}"
            assert result["passed"] and len(result["scenarios"]) == 12, "One or more live scenarios failed"
            status, _ = request(base, "/api/credentials")
            assert status == 401, "Admin API allowed anonymous access"
            status, _ = request(base, "/proxy/customers", token)
            assert status == 401, "Admin credential accepted as relay credential"
            result["lifetime_checks"] = lifetime_checks(base, token)
            result["readiness_passed"] = True
            status, audit = request(base, "/api/audit/export", token)
            assert status == 200 and audit["verification"]["valid"]
            assert token not in json.dumps(audit), "Admin token leaked into audit export"
            assert len(audit["events"]) == audit["verification"]["event_count"]
            result["audit"] = audit["verification"]
            result["admin_boundary_passed"] = True
            result["transport"] = "real-loopback-http"
            text = json.dumps(result, ensure_ascii=False, indent=2)
            if args.output:
                Path(args.output).write_text(text + "\n", encoding="utf-8")
            print(text)
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            if proc.stdout:
                proc.stdout.close()


if __name__ == "__main__":
    main()
