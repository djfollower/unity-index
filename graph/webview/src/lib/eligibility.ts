// Day 4 Task 7: decides which context-menu actions are available for a given
// node. Pure data — separated from the Svelte component so tests can lock in
// the rules without spinning up DOM. Day 11 ("saved views") will reuse the
// same predicates to drive bulk operations.
//
// The rules are intentionally permissive (anything with a `path` opens) and
// trust the host to throw a stable error if the path turns out not to exist.

import type { NodeKind } from '@unity-index/graph-core';

export type ActionId =
  | 'open_file'
  | 'find_usages'
  | 'reveal_in_explorer'
  | 'copy_guid';

export interface ActionDescriptor {
  id: ActionId;
  label: string;
  /** True when the host call is fast and feedback is immediate. Used by the
   *  menu to decide whether to dismiss instantly on click or show a spinner.
   *  Only `copy_guid` qualifies right now — all host hops go through async
   *  bridge requests with their own timeouts. */
  isSync: boolean;
}

// One source-of-truth list so tests + UI iterate the same set.
export const ALL_ACTIONS: ActionDescriptor[] = [
  { id: 'open_file', label: 'Open file', isSync: false },
  { id: 'find_usages', label: 'Find usages', isSync: false },
  { id: 'reveal_in_explorer', label: 'Reveal in OS file manager', isSync: false },
  { id: 'copy_guid', label: 'Copy GUID', isSync: true },
];

// Code-bearing node kinds — only these support "Find usages" because the host
// triggers Rider/VS Code's native references panel against the symbol under
// the caret, and that only makes sense for code. `script` qualifies because
// it maps to a single C# class declaration in Unity's one-class-per-file
// world; Day 8 will add the other code kinds.
const CODE_BEARING_KINDS: ReadonlySet<NodeKind> = new Set([
  'script',
  'class',
  'interface',
  'struct',
  'enum',
  'method',
  'property',
  'field',
]);

export interface NodeFacts {
  kind: NodeKind | string;
  hasPath: boolean;
  hasGuid: boolean;
}

/** Decide which actions apply to a node. Order matches ALL_ACTIONS so the
 *  rendered menu stays stable across kinds (no shuffling as user moves
 *  cursor between different nodes). */
export function actionsForNode(facts: NodeFacts): ActionDescriptor[] {
  return ALL_ACTIONS.filter((action) => isEligible(action.id, facts));
}

export function isEligible(action: ActionId, facts: NodeFacts): boolean {
  switch (action) {
    case 'open_file':
    case 'reveal_in_explorer':
      return facts.hasPath;
    case 'find_usages':
      return facts.hasPath && CODE_BEARING_KINDS.has(facts.kind as NodeKind);
    case 'copy_guid':
      return facts.hasGuid;
  }
}
