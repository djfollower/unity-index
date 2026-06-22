#!/usr/bin/env python3
"""
Windows stdio-to-HTTP bridge for Unity Index MCP.

Same wire protocol as unity-mcp-bridge-http.py but uses binary mode on
stdin/stdout so MCP clients on Windows (Claude Desktop, Cursor, Unity AI
Assistant) get framing right even when the launching shell rewrites
newlines.

Works with both editor variants:
  - Rider plugin       (default port 29170)
  - VS Code extension  (default port 29270)

Override via --port or UNITY_INDEX_PORT.
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


def send_request(host: str, port: int, body: bytes) -> bytes:
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
    parser = argparse.ArgumentParser(
        description="Windows stdio-to-HTTP bridge for Unity Index MCP."
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("UNITY_INDEX_HOST", "127.0.0.1"),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("UNITY_INDEX_PORT", "29170")),
        help="29170 = Rider plugin (default); 29270 = VS Code extension.",
    )
    args = parser.parse_args()

    # Force binary mode on Windows stdin/stdout pipes — otherwise CRLF
    # translation breaks JSON-RPC framing when the launcher pipes text.
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(),  os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    stdin  = open(sys.stdin.fileno(),  "rb", closefd=False, buffering=0)
    stdout = open(sys.stdout.fileno(), "wb", closefd=False, buffering=0)

    buf = b""
    while True:
        try:
            ch = stdin.read(1)
        except Exception as e:
            sys.stderr.write(f"stdin read error: {type(e).__name__}: {e}\n")
            sys.stderr.flush()
            break

        if ch == b"":
            break  # EOF — MCP host closed the pipe

        if ch == b"\n":
            line = buf.strip()
            buf  = b""
            if not line:
                continue
            try:
                response_body = send_request(args.host, args.port, line)
                if response_body:
                    stdout.write(response_body + b"\n")
                    stdout.flush()
            except Exception as e:
                sys.stderr.write(f"Bridge error: {e}\n")
                sys.stderr.flush()
        else:
            buf += ch


if __name__ == "__main__":
    main()
