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


def request(base, path, token=None, post=False):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(base + path, data=b"" if post else None, headers=headers, method="POST" if post else "GET")
    try:
        with LOCAL_HTTP.open(req, timeout=30) as response:
            return response.status, json.load(response)
    except HTTPError as exc:
        return exc.code, json.load(exc)


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
            status, result = request(base, "/api/demo/run", token, post=True)
            assert status == 200, f"Scenario endpoint returned {status}"
            assert result["passed"] and len(result["scenarios"]) == 12, "One or more live scenarios failed"
            status, _ = request(base, "/api/credentials")
            assert status == 401, "Admin API allowed anonymous access"
            status, _ = request(base, "/proxy/customers", token)
            assert status == 401, "Admin credential accepted as relay credential"
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
