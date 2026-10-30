"""Install a built wheel away from the checkout and verify its actual contents.

Dependencies come from the invoking interpreter; installation uses --no-index
and --no-deps. The application must resolve inside the temporary environment,
never through the source checkout or an editable installation. No server socket
or external service is required.
"""

from __future__ import annotations

import argparse
from email.parser import BytesParser
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import tempfile
import zipfile


_CHECK = r'''
import importlib.metadata
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
import sysconfig

import httpx
from fastapi.testclient import TestClient
import relayguard
import relayguard.cli
from relayguard.app import create_app
from relayguard.settings import Settings

root = Path(sysconfig.get_path("purelib")).resolve()
module = Path(relayguard.__file__).resolve()
assert module.is_relative_to(root), "Imported source checkout instead of installed wheel"
assert importlib.metadata.version("relayguard") == sys.argv[1], "Installed version differs from wheel"

class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {"src", "href"} and value and value.startswith("/static/"):
                self.paths.add(value)

def no_upstream(request):
    raise AssertionError("Static wheel verification must not call an upstream")

settings = Settings(upstream_url="https://example.invalid", upstream_token="synthetic-provider-token",
                    admin_token="synthetic-admin-" + "x" * 48, database_path="smoke.db")
app = create_app(settings, upstream_transport=httpx.MockTransport(no_upstream))
with TestClient(app) as client:
    html = client.get("/")
    assert html.status_code == 200 and 'id="connect-form"' in html.text
    assert "frame-ancestors 'none'" in html.headers["content-security-policy"]
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.get("/readyz").json()["status"] == "ready"
    assets = Assets()
    assets.feed(html.text)
    assert {"/static/app.js", "/static/style.css"}.issubset(assets.paths)
    assert any(path.endswith(".svg") for path in assets.paths), "Console SVG references missing"
    for path in sorted(assets.paths):
        response = client.get(path)
        assert response.status_code == 200 and response.content, f"Missing packaged asset: {path}"
        if path.endswith(".svg"):
            assert "<svg" in response.text, f"Invalid packaged SVG: {path}"
    assert (module.parent / "static/icons/LICENSE").is_file(), "Icon license is missing"
for name, loaded in tuple(sys.modules.items()):
    if name.startswith("relayguard.") and getattr(loaded, "__file__", None):
        assert Path(loaded.__file__).resolve().is_relative_to(root), f"Source fallback import: {name}"
print(json.dumps({"passed": True, "version": sys.argv[1], "static_assets": len(assets.paths),
                  "import_source": "temporary-installed-wheel", "transport": "in-process"}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", nargs="?", help="Wheel path; defaults to the only relayguard wheel in dist/")
    args = parser.parse_args()
    if args.wheel:
        wheel = Path(args.wheel).resolve()
    else:
        wheels = sorted(Path("dist").glob("relayguard-*.whl"))
        if len(wheels) != 1:
            parser.error("Provide a wheel path, or keep exactly one relayguard wheel in dist/")
        wheel = wheels[0].resolve()
    if not wheel.is_file():
        parser.error("The wheel file does not exist")
    with zipfile.ZipFile(wheel) as archive:
        metadata_paths = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(metadata_paths) != 1:
            parser.error("Expected exactly one wheel METADATA entry")
        metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
        if metadata["Name"] != "relayguard":
            parser.error("Expected a relayguard wheel")
        version = metadata["Version"]

    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    env["PYTHONNOUSERSITE"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PIP_CONFIG_FILE"] = os.devnull
    with tempfile.TemporaryDirectory(prefix="relayguard-wheel-") as temporary:
        work = Path(temporary)
        venv = work / "venv"
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", str(venv)],
                       cwd=work, env=env, check=True, capture_output=True, text=True, timeout=60)
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        package_dir = Path(subprocess.check_output(
            [str(python), "-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
            cwd=work, env=env, text=True, timeout=15).strip())
        # A venv created from another venv does not inherit that venv's packages.
        # Expose dependency files only; do not execute its editable-import .pth
        # hooks or add the repository to sys.path. The wheel location is asserted
        # in the subprocess, so an accidental source import fails this check.
        dependency_dir = Path(sysconfig.get_path("purelib")).resolve()
        (package_dir / "relayguard_smoke_dependencies.pth").write_text(str(dependency_dir) + "\n")
        subprocess.run([str(python), "-I", "-m", "pip", "install", "--no-deps", "--no-index",
                        "--ignore-installed", str(wheel)], cwd=work, env=env,
                       check=True, capture_output=True, text=True, timeout=60)
        entry = venv / ("Scripts/relayguard.exe" if os.name == "nt" else "bin/relayguard")
        help_result = subprocess.run([str(entry), "--help"], cwd=work, env=env,
                                     check=True, capture_output=True, text=True, timeout=15)
        assert all(command in help_result.stdout for command in ("demo", "serve", "check-config", "policy")), "CLI entry point is incomplete"
        policy = work / "policy.json"
        policy.write_text(json.dumps({"name": "Wheel smoke", "ttl_hours": 1, "policy": {
            "routes": [{"method": "GET", "path": "/customers", "query_keys": []}],
            "max_total_requests": 2, "max_total_bytes": 1024,
        }}))
        policy_result = subprocess.run([str(entry), "policy", "check", str(policy)], cwd=work, env=env,
                                       check=True, capture_output=True, text=True, timeout=15)
        assert json.loads(policy_result.stdout)["passed"] is True, "Installed policy command failed"
        checked = subprocess.run([str(python), "-I", "-c", _CHECK, version], cwd=work, env=env,
                                 check=True, capture_output=True, text=True, timeout=30)
        print(json.dumps({**json.loads(checked.stdout), "cli_entry_point": True, "static_policy_cli": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print("Wheel smoke subprocess failed.", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr, end="")
        raise SystemExit(1) from None
