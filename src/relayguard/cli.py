import argparse
import os
import secrets
import socket
import threading
import time

import uvicorn

from .app import create_app
from .demo_upstream import create_demo_upstream
from .settings import Settings


def config(app, host, port, cert=None, key=None):
    # Never trust X-Forwarded-For implicitly. Access logs can contain query secrets.
    return uvicorn.Config(app, host=host, port=port, proxy_headers=False, access_log=False,
                          log_level="warning", limit_concurrency=100, backlog=128,
                          timeout_keep_alive=5, ssl_certfile=cert, ssl_keyfile=key)


def main():
    parser = argparse.ArgumentParser(description="RelayGuard credential boundary")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="Start gateway + synthetic CRM (loopback by default)")
    demo.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1",
                      help="Gateway bind address; use 0.0.0.0 inside a container")
    demo.add_argument("--port", type=int, default=8810)
    demo.add_argument("--upstream-port", type=int, default=8811)
    demo.add_argument("--db", default=".relayguard/demo.db")
    serve = sub.add_parser("serve", help="Run configured gateway (requires environment secrets)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8810)
    serve.add_argument("--tls-cert", help="PEM certificate for direct TLS termination")
    serve.add_argument("--tls-key", help="PEM private key for direct TLS termination")
    sub.add_parser("generate-admin-token", help="Print a new random admin token")
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "generate-admin-token":
        print(secrets.token_urlsafe(48))
        return
    if args.command == "serve":
        if bool(args.tls_cert) != bool(args.tls_key):
            parser.error("--tls-cert and --tls-key must be set together")
        if not 1 <= args.port <= 65535:
            parser.error("Port must be between 1 and 65535")
        try:
            app = create_app(Settings.from_env())
        except (ValueError, OSError) as exc:
            parser.error(str(exc))
        uvicorn.Server(config(app, args.host, args.port, args.tls_cert, args.tls_key)).run()
        return

    if not (1024 <= args.port <= 65535 and 1024 <= args.upstream_port <= 65535) or args.port == args.upstream_port:
        parser.error("Choose distinct ports between 1024 and 65535")
    # Preflight avoids printing usable-looking instructions for a port conflict.
    for host, port in ((args.host, args.port), ("127.0.0.1", args.upstream_port)):
        try:
            with socket.socket() as sock:
                sock.bind((host, port))
        except OSError:
            parser.error(f"Local port {port} is unavailable")
    admin_token, upstream_token = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    settings = Settings(upstream_url=f"http://127.0.0.1:{args.upstream_port}",
                        upstream_token=upstream_token, admin_token=admin_token, database_path=args.db,
                        demo_mode=True, demo_gateway_url=f"http://127.0.0.1:{args.port}")
    upstream = uvicorn.Server(config(create_demo_upstream(upstream_token), "127.0.0.1", args.upstream_port))
    thread = threading.Thread(target=upstream.run, daemon=True)
    thread.start()
    for _ in range(100):
        if upstream.started:
            break
        if not thread.is_alive():
            parser.error("Synthetic upstream did not start")
        time.sleep(0.05)
    else:
        parser.error("Synthetic upstream startup timed out")
    print(f"\nRelayGuard DEMO — synthetic data only\nDashboard: http://127.0.0.1:{args.port}\n"
          f"Admin token (local demo only; regenerated on restart):\n{admin_token}\n"
          "Paste the token in the dashboard, then run the verification scenarios.\n", flush=True)
    try:
        uvicorn.Server(config(create_app(settings), args.host, args.port)).run()
    finally:
        upstream.should_exit = True
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
