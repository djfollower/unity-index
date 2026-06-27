import { describe, expect, it, vi } from 'vitest';
import type { BridgeEnvelope, HostBridge } from './host-bridge.js';
import { request } from './host-bridge.js';

function makeLoopbackBridge(handle: (env: BridgeEnvelope) => BridgeEnvelope | void): HostBridge {
  const listeners = new Set<(env: BridgeEnvelope) => void>();
  return {
    postToHost: (env) => {
      queueMicrotask(() => {
        const reply = handle(env);
        if (reply) for (const l of listeners) l(reply);
      });
    },
    onFromHost: (h) => {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
}

describe('host-bridge request()', () => {
  it('resolves with the matching response payload', async () => {
    const bridge = makeLoopbackBridge((env) => {
      if (env.kind !== 'request') return;
      return { kind: 'response', id: env.id, type: env.type, payload: { ok: true } };
    });
    await expect(request<{}, { ok: boolean }>(bridge, 'x', {})).resolves.toEqual({ ok: true });
  });

  it('rejects when the host returns an error envelope', async () => {
    const bridge = makeLoopbackBridge((env) => {
      if (env.kind !== 'request') return;
      return { kind: 'response', id: env.id, type: env.type, error: { message: 'nope' } };
    });
    await expect(request(bridge, 'x', {})).rejects.toThrow('nope');
  });

  it('ignores responses with a different correlation id', async () => {
    vi.useFakeTimers();
    const bridge = makeLoopbackBridge((env) => {
      if (env.kind !== 'request') return;
      return { kind: 'response', id: 'unrelated', type: env.type, payload: { ok: true } };
    });
    // Attach .rejects BEFORE advancing timers: under fake timers the rejection
    // fires synchronously inside advanceTimersByTimeAsync, and an unattached
    // promise rejection trips Vitest's unhandled-rejection guard.
    const assertion = expect(
      request(bridge, 'x', {}, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects after the timeout when no response arrives', async () => {
    vi.useFakeTimers();
    const bridge = makeLoopbackBridge(() => undefined);
    const assertion = expect(
      request(bridge, 'x', {}, { timeoutMs: 25 }),
    ).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    vi.useRealTimers();
  });
});
