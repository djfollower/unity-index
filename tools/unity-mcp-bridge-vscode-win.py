#!/usr/bin/env python3
r"""
Windows stdio-to-named-pipe bridge for the VS Code variant of
Unity Index MCP.

Why named pipes on Windows
--------------------------
Node's `net.createServer().listen(path)` creates a Windows **named pipe**
(NPFS), not an AF_UNIX socket. So the VS Code extension on Windows
listens on `\\.\pipe\unity-index-mcp-vscode`, which Python can't reach
through the standard `socket` module.

This bridge talks to that named pipe via `kernel32.CreateFileA` /
`ReadFile` / `WriteFile`, then speaks HTTP over the handle the same way
the other bridges do.

Override the pipe via the UNITY_INDEX_PIPE env var, or call with
`--pipe <name>` (with or without the `\\.\pipe\` prefix).
"""

import sys
import os
import ctypes
import ctypes.wintypes
import argparse

DEFAULT_PIPE_NAME = "unity-index-mcp-vscode"
ENDPOINT = "/unity-index-mcp/streamable-http"

# ---------------------------------------------------------------------------
# kernel32 named-pipe client
# ---------------------------------------------------------------------------

INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
GENERIC_READ  = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
PIPE_READMODE_BYTE = 0x00000000  # default byte-stream mode

ERROR_PIPE_BUSY = 231

kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)

kernel32.CreateFileA.argtypes = [
    ctypes.c_char_p,                # lpFileName
    ctypes.wintypes.DWORD,          # dwDesiredAccess
    ctypes.wintypes.DWORD,          # dwShareMode
    ctypes.c_void_p,                # lpSecurityAttributes
    ctypes.wintypes.DWORD,          # dwCreationDisposition
    ctypes.wintypes.DWORD,          # dwFlagsAndAttributes
    ctypes.c_void_p,                # hTemplateFile
]
kernel32.CreateFileA.restype = ctypes.wintypes.HANDLE

kernel32.WriteFile.argtypes = [
    ctypes.wintypes.HANDLE,
    ctypes.c_char_p,
    ctypes.wintypes.DWORD,
    ctypes.POINTER(ctypes.wintypes.DWORD),
    ctypes.c_void_p,
]
kernel32.WriteFile.restype = ctypes.wintypes.BOOL

kernel32.ReadFile.argtypes = [
    ctypes.wintypes.HANDLE,
    ctypes.c_char_p,
    ctypes.wintypes.DWORD,
    ctypes.POINTER(ctypes.wintypes.DWORD),
    ctypes.c_void_p,
]
kernel32.ReadFile.restype = ctypes.wintypes.BOOL

kernel32.WaitNamedPipeA.argtypes = [ctypes.c_char_p, ctypes.wintypes.DWORD]
kernel32.WaitNamedPipeA.restype  = ctypes.wintypes.BOOL

kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
kernel32.CloseHandle.restype  = ctypes.wintypes.BOOL


def normalize_pipe_path(name: str) -> bytes:
    if name.startswith(r"\\."):
        return name.encode("utf-8")
    return rf"\\.\pipe\{name}".encode("utf-8")


def open_pipe(pipe_path: bytes, total_timeout_ms: int = 5000) -> int:
    """Connects to a Windows named pipe, retrying briefly if it's busy."""
    waited = 0
    step   = 200
    while True:
        handle = kernel32.CreateFileA(
            pipe_path,
            GENERIC_READ | GENERIC_WRITE,
            0,        # no sharing
            None,
            OPEN_EXISTING,
            0,        # no special flags (synchronous)
            None,
        )
        if handle and handle != INVALID_HANDLE_VALUE:
            return handle

        err = ctypes.get_last_error()
        if err != ERROR_PIPE_BUSY or waited >= total_timeout_ms:
            raise OSError(
                f"CreateFile({pipe_path.decode('utf-8', 'replace')}) failed "
                f"(WinError {err}). Is the VS Code extension running?"
            )

        # Pipe is busy — wait for a free instance, then retry.
        kernel32.WaitNamedPipeA(pipe_path, step)
        waited += step


def _write_all(handle: int, data: bytes) -> None:
    written = ctypes.wintypes.DWORD(0)
    total = 0
    while total < len(data):
        ok = kernel32.WriteFile(
            handle,
            data[total:],
            len(data) - total,
            ctypes.byref(written),
            None,
        )
        if not ok or written.value == 0:
            raise OSError(f"WriteFile failed (WinError {ctypes.get_last_error()})")
        total += written.value


def _read_n(handle: int, n: int) -> bytes:
    buf = ctypes.create_string_buffer(4096)
    out = b""
    read_count = ctypes.wintypes.DWORD(0)
    while len(out) < n:
        want = min(4096, n - len(out))
        ok = kernel32.ReadFile(handle, buf, want, ctypes.byref(read_count), None)
        if not ok or read_count.value == 0:
            break
        out += buf.raw[:read_count.value]
    return out


def _read_until_headers(handle: int) -> bytes:
    buf = ctypes.create_string_buffer(1)
    out = b""
    read_count = ctypes.wintypes.DWORD(0)
    while b"\r\n\r\n" not in out:
        ok = kernel32.ReadFile(handle, buf, 1, ctypes.byref(read_count), None)
        if not ok or read_count.value == 0:
            break
        out += buf.raw[:1]
    return out


# ---------------------------------------------------------------------------
# HTTP over named pipe
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


def send_request(pipe_path: bytes, body: bytes) -> bytes:
    handle = open_pipe(pipe_path)
    try:
        _write_all(handle, build_http_request(body))
        header_bytes = _read_until_headers(handle)
        if b"\r\n\r\n" not in header_bytes:
            return b""
        content_length = parse_content_length(header_bytes)
        if content_length > 0:
            return _read_n(handle, content_length)
        return b""
    finally:
        kernel32.CloseHandle(handle)


# ---------------------------------------------------------------------------
# Main: stdio loop
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Windows stdio-to-named-pipe bridge for Unity Index MCP (VS Code)."
    )
    parser.add_argument(
        "--pipe",
        default=os.environ.get("UNITY_INDEX_PIPE", DEFAULT_PIPE_NAME),
        help=r"Pipe name (e.g. 'unity-index-mcp-vscode') or full path "
             r"(e.g. '\\.\pipe\unity-index-mcp-vscode').",
    )
    args = parser.parse_args()
    pipe_path = normalize_pipe_path(args.pipe)

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
                response_body = send_request(pipe_path, line)
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
