// Day 11 — bridge round-trip for the shared save-file endpoint. Backs the
// PNG (Task 4), SVG (Task 5), and JSON (Task 6) export buttons.

import {
  SAVE_FILE_TYPE,
  request,
  type HostBridge,
  type SaveFileKind,
  type SaveFileRequest,
  type SaveFileResponse,
} from '@unity-index/graph-core';

const SAVE_TIMEOUT_MS = 120_000;

export interface SaveFileArgs {
  defaultName: string;
  kind: SaveFileKind;
  contentBase64: string;
}

export async function saveFile(
  bridge: HostBridge,
  args: SaveFileArgs,
): Promise<SaveFileResponse> {
  return await request<SaveFileRequest, SaveFileResponse>(
    bridge,
    SAVE_FILE_TYPE,
    args,
    { timeoutMs: SAVE_TIMEOUT_MS },
  );
}

/** Encode a Uint8Array (binary content — e.g. PNG bytes) to base64 without
 *  spilling `apply(...args)` argument-count limits on large buffers. Iterates
 *  in 32 KiB chunks so a 20 MB screenshot still encodes in one pass. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/** Encode a string (SVG / JSON) to base64. Uses TextEncoder so multi-byte
 *  UTF-8 codepoints round-trip cleanly. */
export function stringToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}
