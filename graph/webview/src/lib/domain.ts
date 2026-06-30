// Day 9 — domain classification. The assets/code/combined toggle is a bulk
// macro over kind-level visibility: at any moment a node is rendered iff its
// kind is allowed by BOTH the domain toggle AND the per-kind FilterSidebar.
//
// The boundary between "asset domain" and "code domain" is the
// `script_declares_class` edge (schema §3.1). On the asset side: every kind
// that comes from YAML harvesting (scripts, prefabs, scenes, SOs, generic
// assets). On the code side: every kind that comes from Roslyn/RD
// (namespaces, types, members). The `script` node sits on the asset side —
// it's a `.cs` file with a GUID, the C# *class* declared inside the script
// is the code-domain anchor.
//
// Anything we don't recognise (a future kind shipped by a newer host) falls
// back to the asset domain so the toggle remains conservative: it shows
// rather than hides on uncertainty.

import type { EdgeKind, FilterDomain, NodeKind } from '@unity-index/graph-core';

const CODE_NODE_KINDS = new Set<NodeKind>([
  'namespace',
  'class',
  'interface',
  'struct',
  'enum',
  'method',
  'property',
  'field',
]);

const CODE_EDGE_KINDS = new Set<EdgeKind>([
  'class_inherits_from',
  'class_implements_interface',
  'method_overrides_method',
  'method_calls_method',
  'class_references_class',
]);

export function isCodeNodeKind(kind: string): boolean {
  return CODE_NODE_KINDS.has(kind as NodeKind);
}

export function isCodeEdgeKind(kind: string): boolean {
  return CODE_EDGE_KINDS.has(kind as EdgeKind);
}

/** True iff a node of `kind` is hidden by the domain toggle alone. */
export function nodeHiddenByDomain(domain: FilterDomain, kind: string): boolean {
  if (domain === 'combined') return false;
  const code = isCodeNodeKind(kind);
  return domain === 'code' ? !code : code;
}

/** True iff an edge of `kind` is hidden by the domain toggle alone.
 *  Endpoint-based hiding still applies on top — the reducer composes the
 *  two checks. The bridging `script_declares_class` edge is not in either
 *  set, so it follows endpoint visibility (hidden whenever either end is
 *  hidden), which is the behaviour we want in both directions. */
export function edgeHiddenByDomain(domain: FilterDomain, kind: string): boolean {
  if (domain === 'combined') return false;
  const code = isCodeEdgeKind(kind);
  return domain === 'code' ? !code : code;
}

export function isFilterDomain(value: unknown): value is FilterDomain {
  return value === 'assets' || value === 'code' || value === 'combined';
}
