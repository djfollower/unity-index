#!/usr/bin/env python3
"""
Stdio-to-HTTP bridge for Unity Index MCP.

Works with both the Rider plugin (default port 29170) and the VS Code
extension (default port 29270). Set UNITY_INDEX_PORT to override.

Pass --port <N> on the command line to override at launch.
"""

import sys
import os
import socket
import argparse

ENDPOINT = "/unity-index-mcp/streamable-http"


def recv_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def send_request(host, port, body):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(120)
    sock.connect((host, port))
    try:
        request = (
            f"POST {ENDPOINT} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n"
        ).encode("utf-8") + body

        sock.sendall(request)

        header_bytes = b""
        while b"\r\n\r\n" not in header_bytes:
            b = sock.recv(1)
            if not b:
                return b""
            header_bytes += b

        headers = header_bytes.decode("utf-8", errors="replace")
        content_length = 0
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
                break

        if content_length > 0:
            return recv_exactly(sock, content_length)
        return b""
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description="Stdio-to-HTTP bridge for Unity Index MCP.")
    parser.add_argument("--host", default=os.environ.get("UNITY_INDEX_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("UNITY_INDEX_PORT", "29170")),
        help="29170 = Rider plugin (default); 29270 = VS Code extension.",
    )
    args = parser.parse_args()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            response_body = send_request(args.host, args.port, line.encode("utf-8"))
            if response_body:
                sys.stdout.write(response_body.decode("utf-8") + "\n")
                sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"Bridge error: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
