#!/usr/bin/env python3
"""
Stdio-to-Unix-socket bridge for Unity MCP.

Unity spawns this via "type": "stdio". It reads JSON-RPC from stdin,
sends HTTP POST to the Rider plugin's Unix domain socket, and writes
responses to stdout.

Windows note: uses ctypes + ws2_32.dll directly for AF_UNIX support,
since Python 3.14 on Windows may not expose socket.AF_UNIX even on
eligible Windows 10/11 builds.
"""

import sys
import os
import ctypes
import ctypes.wintypes

SOCKET_PATH = os.environ.get("UNITY_INDEX_SOCKET", "/tmp/unity-index-mcp.sock")
ENDPOINT = "/unity-index-mcp/streamable-http"

# ---------------------------------------------------------------------------
# Winsock AF_UNIX via ctypes
# ---------------------------------------------------------------------------

AF_UNIX    = 1
SOCK_STREAM = 1
INVALID_SOCKET = ctypes.c_size_t(-1).value  # INVALID_SOCKET = (SOCKET)(~0)

class WSADATA(ctypes.Structure):
    _fields_ = [
        ("wVersion",      ctypes.c_ushort),
        ("wHighVersion",  ctypes.c_ushort),
        ("szDescription", ctypes.c_char * 257),
        ("szSystemStatus",ctypes.c_char * 129),
        ("iMaxSockets",   ctypes.c_ushort),
        ("iMaxUdpDg",     ctypes.c_ushort),
        ("lpVendorInfo",  ctypes.c_char_p),
    ]

class SOCKADDR_UN(ctypes.Structure):
    _fields_ = [
        ("sun_family", ctypes.c_ushort),
        ("sun_path",   ctypes.c_char * 108),
    ]

ws2 = ctypes.WinDLL("ws2_32.dll")
ws2.socket.restype   = ctypes.c_size_t   # SOCKET (uintptr_t)
ws2.connect.restype  = ctypes.c_int
ws2.send.restype     = ctypes.c_int
ws2.recv.restype     = ctypes.c_int
ws2.closesocket.restype = ctypes.c_int
ws2.WSAGetLastError.restype = ctypes.c_int

_wsadata = WSADATA()
_rc = ws2.WSAStartup(0x0202, ctypes.byref(_wsadata))
if _rc != 0:
    sys.stderr.write(f"WSAStartup failed: {_rc}\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Low-level send / recv helpers using the raw SOCKET handle
# ---------------------------------------------------------------------------

def _send_all(sock_fd, data: bytes):
    view = memoryview(data)
    total = 0
    while total < len(data):
        chunk = bytes(view[total:total + 65536])
        buf   = ctypes.create_string_buffer(chunk)
        sent  = ws2.send(sock_fd, buf, len(chunk), 0)
        if sent <= 0:
            raise OSError(f"send() failed: WSAError {ws2.WSAGetLastError()}")
        total += sent


def _recv_n(sock_fd, n: int) -> bytes:
    buf  = ctypes.create_string_buffer(4096)
    data = b""
    while len(data) < n:
        want = min(4096, n - len(data))
        got  = ws2.recv(sock_fd, buf, want, 0)
        if got <= 0:
            break
        data += buf.raw[:got]
    return data


def _recv_until_headers(sock_fd) -> bytes:
    """Read byte by byte until we see the end of HTTP headers."""
    buf  = ctypes.create_string_buffer(1)
    data = b""
    while b"\r\n\r\n" not in data:
        got = ws2.recv(sock_fd, buf, 1, 0)
        if got <= 0:
            break
        data += buf.raw[:1]
    return data


# ---------------------------------------------------------------------------
# HTTP over Unix domain socket
# ---------------------------------------------------------------------------

def build_http_request(body: bytes) -> bytes:
    header = (
        f"POST {ENDPOINT} HTTP/1.1\r\n"
        f"Host: localhost\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode("utf-8")
    return header + body


def parse_content_length(header_bytes: bytes) -> int:
    headers = header_bytes.decode("utf-8", errors="replace")
    for line in headers.split("\r\n"):
        if line.lower().startswith("content-length:"):
            return int(line.split(":", 1)[1].strip())
    return 0


def send_request(uds_path: str, body: bytes) -> bytes:
    sock_fd = ws2.socket(AF_UNIX, SOCK_STREAM, 0)
    if sock_fd == INVALID_SOCKET:
        raise OSError(f"socket() failed: WSAError {ws2.WSAGetLastError()}")

    try:
        addr = SOCKADDR_UN()
        addr.sun_family = AF_UNIX
        addr.sun_path   = uds_path.encode("utf-8")

        ret = ws2.connect(sock_fd, ctypes.byref(addr), ctypes.sizeof(addr))
        if ret != 0:
            raise OSError(
                f"connect() to {uds_path} failed: WSAError {ws2.WSAGetLastError()} "
                f"(is Unity + Rider plugin running?)"
            )

        _send_all(sock_fd, build_http_request(body))

        header_bytes = _recv_until_headers(sock_fd)
        if b"\r\n\r\n" not in header_bytes:
            return b""

        content_length = parse_content_length(header_bytes)
        if content_length > 0:
            return _recv_n(sock_fd, content_length)
        return b""

    finally:
        ws2.closesocket(sock_fd)


# ---------------------------------------------------------------------------
# Main: stdio loop
# ---------------------------------------------------------------------------

def main():
    # Force binary mode on Windows stdin/stdout pipes
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
                response_body = send_request(SOCKET_PATH, line)
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
