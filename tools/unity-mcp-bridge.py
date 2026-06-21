#!/usr/bin/env python3
"""
Stdio-to-Unix-socket bridge for Unity MCP.

Unity spawns this via "type": "stdio". It reads JSON-RPC from stdin,
sends HTTP POST to the Rider plugin's Unix domain socket, and writes
responses to stdout.
"""

import sys
import socket
import os

SOCKET_PATH = os.environ.get("UNITY_INDEX_SOCKET", "/tmp/unity-index-mcp.sock")
ENDPOINT = "/unity-index-mcp/streamable-http"


def recv_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def send_request(uds_path, body):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(120)
    sock.connect(uds_path)
    try:
        request = (
            f"POST {ENDPOINT} HTTP/1.1\r\n"
            f"Host: localhost\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n"
        ).encode("utf-8") + body

        sock.sendall(request)

        # Read headers byte by byte until \r\n\r\n
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
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            response_body = send_request(SOCKET_PATH, line.encode("utf-8"))
            if response_body:
                sys.stdout.write(response_body.decode("utf-8") + "\n")
                sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"Bridge error: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
