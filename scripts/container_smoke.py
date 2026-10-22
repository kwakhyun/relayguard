"""Verify a built Docker image using only the host Python standard library.

Usage: python scripts/container_smoke.py IMAGE

The image must already exist in the local Docker daemon. HTTP requests use a
random host loopback port, first against the synthetic demo, then the default
production command with synthetic secrets. No production upstream request is
made. Tokens stay in memory; container logs and HTTP bodies are never printed.
"""
import argparse
import json
import os
import re
import secrets as token_secrets
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid


class SmokeError(Exception):
    """A deliberately non-secret diagnostic that is safe to print in CI."""


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirects())
TOKEN_LINE = re.compile(r"Admin token \([^\r\n]*\):\r?\n([A-Za-z0-9_-]{64})\r?\n")


def require(condition, message):
    if not condition:
        raise SmokeError(message)


def docker(*args, timeout=30, environment=None):
    # Never include captured output in an exception: `docker logs` contains the
    # temporary admin token, and daemon errors can contain command arguments.
    try:
        result = subprocess.run(["docker", *args], capture_output=True, text=True,
                                timeout=timeout, check=False, env=environment)
    except FileNotFoundError:
        raise SmokeError("Docker CLI is unavailable") from None
    except subprocess.TimeoutExpired:
        raise SmokeError(f"Docker {args[0]} exceeded its {timeout}s deadline") from None
    except OSError:
        raise SmokeError(f"Docker {args[0]} could not be executed") from None
    require(result.returncode == 0,
            f"Docker {args[0]} failed with exit code {result.returncode}; output withheld")
    return result.stdout


def docker_json(*args):
    try:
        return json.loads(docker(*args))
    except (ValueError, TypeError):
        raise SmokeError(f"Docker {args[0]} returned invalid JSON") from None


def request(base, path, token=None, *, method="GET", payload=None, timeout=45):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    elif method == "POST":
        data = b""
    req = Request(base + path, data=data, headers=headers, method=method)
    try:
        response = HTTP.open(req, timeout=timeout)
    except HTTPError as exc:
        response = exc
    with response:
        body = response.read(2 * 1024 * 1024 + 1)
        require(len(body) <= 2 * 1024 * 1024, f"Response too large at {path}")
        return response.code, {key.lower(): value for key, value in response.headers.items()}, body


def expect(base, path, status, token=None, **kwargs):
    actual, headers, body = request(base, path, token, **kwargs)
    require(actual == status, f"{path}: expected HTTP {status}, received {actual}")
    require(headers.get("cache-control") == "no-store", f"{path}: missing no-store header")
    return headers, body


def expect_json(base, path, status, token=None, **kwargs):
    _, body = expect(base, path, status, token, **kwargs)
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise SmokeError(f"{path}: response is not JSON") from None


def start_container(image, name, volume, *, production_env=None):
    options = []
    environment = None
    command = ["relayguard", "demo", "--host", "0.0.0.0", "--db", "/data/demo.db"]
    if production_env is not None:
        # Forward values through the subprocess environment, not command-line
        # arguments. Leave the image command and database setting unchanged.
        environment = {**os.environ, **production_env}
        for key in production_env:
            options.extend(["--env", key])
        command = []
    docker("run", "--detach", "--pull=never", "--name", name,
           "--publish", "127.0.0.1::8810", "--read-only",
           "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges:true",
           "--mount", f"type=volume,source={volume},target=/data",
           *options, image, *command, environment=environment)
    ports = docker_json("inspect", "--format", "{{json .NetworkSettings.Ports}}", name)
    bindings = ports.get("8810/tcp") or []
    require(len(bindings) == 1 and bindings[0].get("HostIp") == "127.0.0.1",
            "Gateway must be published only on host loopback")
    require(all(not value for port, value in ports.items() if port != "8810/tcp"),
            "Unexpected published container port")
    port = bindings[0].get("HostPort", "")
    require(port.isdigit() and 0 < int(port) <= 65535, "Invalid assigned host port")
    return f"http://127.0.0.1:{port}"


def wait_ready(name, base, previous_token=None, *, admin_token=None):
    demo_mode = admin_token is None
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        state = docker_json("inspect", "--format", "{{json .State}}", name)
        require(state.get("Running"),
                f"Container stopped before readiness (exit code {state.get('ExitCode')})")
        tokens = (TOKEN_LINE.findall(docker("logs", "--tail", "100", name))
                  if demo_mode else [admin_token])
        if tokens and tokens[-1] != previous_token:
            try:
                status, _, body = request(base, "/healthz", timeout=2)
                if status == 200:
                    health = json.loads(body)
                    require(health.get("status") == "ok" and health.get("demo_mode") is demo_mode,
                            "Unexpected health response or application mode")
                    expect_json(base, "/api/overview", 200, tokens[-1], timeout=2)
                    return tokens[-1]
            except (OSError, URLError, ValueError):
                pass
        time.sleep(0.25)
    raise SmokeError("Container readiness exceeded its 40s deadline; logs withheld")


def verify_runtime(name, volume, *, database_path="/data/demo.db"):
    config = docker_json("inspect", "--format", "{{json .HostConfig}}", name)
    require(config.get("ReadonlyRootfs") is True, "Root filesystem is not read-only")
    mounts = docker_json("inspect", "--format", "{{json .Mounts}}", name)
    require(any(m.get("Name") == volume and m.get("Destination") == "/data"
                and m.get("RW") is True for m in mounts), "Writable data volume is missing")
    # Report booleans only. This also verifies the running user, not merely image
    # metadata, and checks the kernel actually applied the hardening options.
    result = docker_json("exec", name, "python", "-c", """
import json, os, pathlib, sys, tempfile
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines())
root_ro = any(line.split()[1] == '/' and 'ro' in line.split()[3].split(',')
              for line in pathlib.Path('/proc/mounts').read_text().splitlines())
with tempfile.TemporaryFile(dir='/tmp') as scratch:
    scratch.write(b'probe')
db = pathlib.Path(sys.argv[1]).stat()
directory = pathlib.Path('/data').stat()
print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'root_ro': root_ro,
                  'no_capabilities': int(status['CapEff'].strip(), 16) == 0,
                  'no_new_privileges': status['NoNewPrivs'].strip() == '1',
                  'database_private': db.st_uid == 10001 and db.st_mode & 0o777 == 0o600,
                  'data_directory_private': directory.st_uid == 10001 and directory.st_mode & 0o777 == 0o700}))
""", database_path)
    require(result.get("uid") == 10001 and result.get("gid") == 10001,
            "Container is not running as UID/GID 10001")
    for key in ("root_ro", "no_capabilities", "no_new_privileges", "database_private",
                "data_directory_private"):
        require(result.get(key) is True, f"Runtime hardening check failed: {key}")


def verify_dashboard_and_boundaries(base, admin):
    headers, html = expect(base, "/", 200)
    require(b"RelayGuard" in html and b'id="connect-form"' in html,
            "Dashboard HTML is missing")
    require("frame-ancestors 'none'" in headers.get("content-security-policy", ""),
            "Dashboard security policy is missing")
    for path in ("/static/app.js", "/static/style.css"):
        _, body = expect(base, path, 200)
        require(len(body) > 100, f"Dashboard asset is empty: {path}")
    for path, method in (("/api/overview", "GET"), ("/api/credentials", "GET"),
                         ("/api/audit/export", "GET"), ("/api/demo/run", "POST")):
        expect(base, path, 401, method=method)
    expect(base, "/api/credentials", 401, "invalid-admin-token")
    expect(base, "/proxy/customers", 401, admin)


def issue(base, admin, name):
    item = expect_json(base, "/api/credentials", 201, admin, method="POST", payload={
        "name": name, "ttl_hours": 1,
        "policy": {"routes": [{"method": "GET", "path": "/customers", "query_keys": ["limit"]}]},
    })
    require(isinstance(item.get("token"), str) and item["token"].startswith("rg_"),
            "Credential creation did not return a relay token")
    require(isinstance(item.get("credential", {}).get("id"), str),
            "Credential creation did not return an identifier")
    return item


def audit_export(base, admin, secrets):
    audit = expect_json(base, "/api/audit/export", 200, admin)
    verification = audit.get("verification", {})
    require(verification.get("valid") is True, "Audit chain verification failed")
    require(len(audit.get("events", [])) == verification.get("event_count"),
            "Audit event count does not match its verification")
    encoded = json.dumps(audit)
    require(all(secret not in encoded for secret in secrets), "A raw token appeared in audit export")
    return audit


def verify_production(base, admin, upstream_token):
    health = expect_json(base, "/healthz", 200)
    require(health.get("status") == "ok" and health.get("demo_mode") is False,
            "Default image command did not start production mode")
    overview = expect_json(base, "/api/overview", 200, admin)
    require(overview.get("demo_mode") is False
            and overview.get("upstream_origin") == "https://example.invalid",
            "Production environment settings were not applied")
    expect(base, "/api/overview", 401)
    expect(base, "/api/overview", 401, upstream_token)
    blocked = expect_json(base, "/api/demo/run", 404, admin, method="POST")
    require(blocked.get("error", {}).get("code") == "not_found",
            "Production mode did not disable demo scenarios")
    # Admin endpoints and health checks do not contact the configured upstream.
    # Never issue a valid relay request to the synthetic production origin.
    audit_export(base, admin, [admin, upstream_token])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Already built or pulled image tag or digest")
    args = parser.parse_args()
    if args.image.startswith("-") or any(c.isspace() for c in args.image):
        parser.error("image must be a single Docker image reference")
    suffix = uuid.uuid4().hex[:12]
    name, volume = f"relayguard-smoke-{suffix}", f"relayguard-smoke-data-{suffix}"
    failed = False
    container_possible = volume_possible = False
    try:
        # Mark resources before commands: a timed-out daemon request may still
        # create the resource, so cleanup must try even after partial failures.
        volume_possible = True
        docker("volume", "create", volume)
        container_possible = True
        base = start_container(args.image, name, volume)
        admin = wait_ready(name, base)
        verify_runtime(name, volume)
        verify_dashboard_and_boundaries(base, admin)
        print("PASS: runtime hardening, dashboard assets, admin boundaries", flush=True)

        result = expect_json(base, "/api/demo/run", 200, admin, method="POST")
        scenarios = result.get("scenarios", [])
        require(result.get("passed") is True and len(scenarios) == 12
                and all(s.get("passed") is True and s.get("actual_status") == s.get("expected_status")
                        for s in scenarios), "One or more of the 12 live HTTP scenarios failed")
        print("PASS: all 12 live HTTP policy scenarios", flush=True)

        active = issue(base, admin, "Container smoke: retained active key")
        revoked = issue(base, admin, "Container smoke: retained revoked key")
        expect(base, "/proxy/customers?limit=1", 200, active["token"])
        expect(base, "/api/credentials", 401, active["token"])
        expect(base, f"/api/credentials/{revoked['credential']['id']}/revoke", 200,
               admin, method="POST")
        expect(base, "/proxy/customers", 401, revoked["token"])
        secrets = [admin, active["token"], revoked["token"]]
        before = audit_export(base, admin, secrets)

        # Recreate instead of merely restarting: persisted state must come from
        # the named volume, not the original container's writable layer.
        docker("stop", "--time", "10", name, timeout=20)
        docker("rm", name)
        base = start_container(args.image, name, volume)
        new_admin = wait_ready(name, base, previous_token=admin)
        verify_runtime(name, volume)
        expect(base, "/api/credentials", 401, admin)
        items = expect_json(base, "/api/credentials", 200, new_admin)["items"]
        rows = {item["id"]: item for item in items}
        active_id, revoked_id = active["credential"]["id"], revoked["credential"]["id"]
        require(active_id in rows and rows[active_id].get("revoked_at") is None,
                "Active credential did not survive container replacement")
        require(revoked_id in rows and rows[revoked_id].get("revoked_at") is not None,
                "Revocation did not survive container replacement")
        expect(base, "/proxy/customers?limit=1", 200, active["token"])
        expect(base, "/proxy/customers", 401, revoked["token"])
        after = audit_export(base, new_admin, [*secrets, new_admin])
        require(after["events"][:len(before["events"])] == before["events"],
                "Existing audit events changed after container replacement")
        print("PASS: volume persistence, active/revoked keys, admin token rotation, audit integrity", flush=True)

        docker("stop", "--time", "10", name, timeout=20)
        docker("rm", name)
        production_admin = token_secrets.token_urlsafe(48)
        production_upstream = token_secrets.token_urlsafe(48)
        base = start_container(args.image, name, volume, production_env={
            "RELAYGUARD_UPSTREAM_URL": "https://example.invalid",
            "RELAYGUARD_UPSTREAM_TOKEN": production_upstream,
            "RELAYGUARD_ADMIN_TOKEN": production_admin,
        })
        wait_ready(name, base, admin_token=production_admin)
        verify_runtime(name, volume, database_path="/data/relayguard.db")
        verify_production(base, production_admin, production_upstream)
        print("PASS: default production command, environment configuration, disabled demo, private database", flush=True)
    except SmokeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        failed = True
    except Exception as exc:
        # Exception reprs can contain request data; emit the class name only.
        print(f"FAIL: unexpected {type(exc).__name__}; details withheld", file=sys.stderr)
        failed = True
    finally:
        if container_possible:
            try:
                docker("rm", "--force", "--volumes", name)
            except SmokeError:
                # Distinguish an already removed object from a daemon failure.
                try:
                    remaining = docker("ps", "--all", "--filter", f"name=^/{name}$", "--quiet")
                    require(not remaining.strip(), "Smoke container could not be removed")
                except SmokeError as exc:
                    print(f"FAIL: cleanup: {exc}", file=sys.stderr)
                    failed = True
        if volume_possible:
            try:
                docker("volume", "rm", volume)
            except SmokeError:
                try:
                    remaining = docker("volume", "ls", "--filter", f"name=^{volume}$", "--quiet")
                    require(not remaining.strip(), "Smoke volume could not be removed")
                except SmokeError as exc:
                    print(f"FAIL: cleanup: {exc}", file=sys.stderr)
                    failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
