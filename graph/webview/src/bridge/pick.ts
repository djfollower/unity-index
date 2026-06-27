import type { HostBridge } from '@unity-index/graph-core';
import { makeNoopBridge } from './noop';
import { makeRiderBridge } from './rider';
import { makeVsCodeBridge } from './vscode';

export type HostKind = 'vscode' | 'rider' | 'standalone';

export interface PickedBridge {
  bridge: HostBridge;
  host: HostKind;
}

export function pickBridge(): PickedBridge {
  if (typeof window.acquireVsCodeApi === 'function') {
    return { bridge: makeVsCodeBridge(), host: 'vscode' };
  }
  if (window.unityIndex) {
    return { bridge: makeRiderBridge(), host: 'rider' };
  }
  return { bridge: makeNoopBridge(), host: 'standalone' };
}
