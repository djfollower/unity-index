// ---------------------------------------------------------------------------
// Day 11 — export/import wire format (schema v1).
//
// Wraps a `GraphSnapshot` (Day 2), the Day 8 `CodeEdgesResponse.snapshot`
// slice, and a list of Day 11 saved views into one self-describing document
// that can be:
//   • downloaded as JSON from the webview export button,
//   • returned from the `unity_graph_export` MCP tool,
//   • re-loaded via the "Open Graph from File…" extension command for
//     offline browsing or PR-review sharing.
//
// This file defines the schema and version-check helpers ONLY. Producers
// (webview / MCP tools) and consumers (import command / webview offline
// mode) live elsewhere and import from here.
//
// Compatibility rule: a bump to `EXPORT_SCHEMA_MAJOR` is a breaking change.
// Consumers MUST refuse documents whose major differs. Minor bumps are
// additive — old fields keep their meaning, new fields are optional.
// ---------------------------------------------------------------------------

import type { CodeEdgeKind } from './code-edges-wire.js';
import type { GraphSnapshot, NodeKind } from './graph-types.js';
import type { TraversalDirection } from './neighbors-wire.js';

/** Bumped on any breaking change to the fields below. */
export const EXPORT_SCHEMA_MAJOR = 1;
/** Bumped on additive changes. Consumers ignore this and only check major. */
export const EXPORT_SCHEMA_MINOR = 0;
export const EXPORT_SCHEMA_VERSION = `${EXPORT_SCHEMA_MAJOR}.${EXPORT_SCHEMA_MINOR}` as const;

/** Producer identifier — helps humans reading the file know which side wrote
 *  it. Kotlin emits `'rider'`, TypeScript emits `'vscode'`, MCP tools emit
 *  `'mcp'` regardless of host so the field means "how" not "where". */
export type ExportProducer = 'rider' | 'vscode' | 'mcp';

/** Filter facet snapshot — mirrors `FilterStore.snapshot()` in the webview.
 *  Kept as a plain wire shape so importers don't need to link the webview
 *  package. */
export interface SavedViewFilter {
  hiddenKinds: NodeKind[];
  search: string;
  /** Matches `FilterDomain` from `messages.ts`. Redeclared as a string union
   *  here to keep core → messages a one-way dependency. */
  domain: 'combined' | 'assets' | 'code';
}

/** Focus stack frame — mirrors `FocusFrame` in the webview's `focus.ts`.
 *  Redeclared for the same one-way-dependency reason as `SavedViewFilter`. */
export interface SavedViewFocusFrame {
  nodeId: string;
  hops: number;
  direction: TraversalDirection;
  kind: 'neighbors' | 'impact';
}

/** Sigma camera state. All three fields are what `sigma.getCamera().getState()`
 *  returns; angle is optional because most exports won't rotate. */
export interface SavedViewCamera {
  x: number;
  y: number;
  ratio: number;
  angle?: number;
}

/** Optional per-node positions after user drags. Omit for exports that
 *  should recompute layout on import — cheaper wire and smaller files.
 *  Keys are node IDs; values are graphology coordinates. */
export type SavedViewPositions = Record<string, { x: number; y: number }>;

export interface SavedView {
  /** User-supplied name, unique within a document. Importers dedupe by
   *  name (last-write-wins) when merging into an existing store. */
  name: string;
  description?: string;
  /** ISO-8601 UTC timestamp. Uses the same format as `GraphSnapshot.generated_at`. */
  createdAt: string;
  filter: SavedViewFilter;
  /** Empty array = no focus (whole graph). Non-empty = the last frame is
   *  the active focus; earlier frames are breadcrumb history. */
  focusStack: SavedViewFocusFrame[];
  camera: SavedViewCamera;
  positions?: SavedViewPositions;
}

/** Code-edge slice — the same shape `unity_graph_code_edges` returns, minus
 *  the request/response envelope. Optional because asset-only exports don't
 *  need it. When present, its `snapshot.source_phase` is `'code'`. */
export interface ExportCodeEdges {
  snapshot: GraphSnapshot;
  /** Passthrough of the filter used when the slice was harvested, so the
   *  importer can re-issue the same query for live updates if the source
   *  project is available. */
  edgeKinds?: CodeEdgeKind[];
  /** Symbol IDs the exporter tried to include but couldn't resolve. Kept
   *  so post-mortem PR reviewers can tell "missing" from "excluded". */
  unresolvedIds?: string[];
}

export interface ExportMeta {
  producer: ExportProducer;
  /** Semver of the plugin/extension that wrote the file. Cross-check against
   *  `gradle.properties` / `package.json` when debugging import failures. */
  producerVersion: string;
  /** Best-effort human label for the source project (folder name or
   *  `.sln` basename). Not used for equality — imported docs are viewed
   *  standalone. */
  sourceProject?: string;
  /** Absolute project path at export time. Included so click-through can be
   *  re-enabled if the same project happens to be open. Consumers MUST
   *  treat a path mismatch as "offline mode only", not an error. */
  sourceProjectPath?: string;
  /** Free-form notes the exporter chose to include (e.g. PR number). */
  note?: string;
}

export interface ExportDocument {
  /** Always the string form of `EXPORT_SCHEMA_MAJOR.EXPORT_SCHEMA_MINOR` at
   *  write time. Consumers parse the major and reject on mismatch. */
  schemaVersion: string;
  /** ISO-8601 UTC. Distinct from `snapshot.generated_at`, which is when
   *  the host minted the graph — this is when the export was serialized. */
  exportedAt: string;
  meta: ExportMeta;
  /** Full asset snapshot (Day 2 shape). Required — every export carries at
   *  least this. `source_phase` reflects what the exporter had loaded:
   *  `'asset'`, `'code'`, or `'combined'`. */
  snapshot: GraphSnapshot;
  /** Present when the exporter had a Phase-2 code slice loaded. */
  codeEdges?: ExportCodeEdges;
  /** Zero or more saved views. Not required to be non-empty — a "quick
   *  export" might have none. */
  savedViews?: SavedView[];
}

// ---------------------------------------------------------------------------
// Version-check helpers
// ---------------------------------------------------------------------------

export type ExportValidationErrorKind =
  | 'not_an_object'
  | 'missing_schema_version'
  | 'malformed_schema_version'
  | 'incompatible_major'
  | 'missing_snapshot';

export class ExportValidationError extends Error {
  readonly kind: ExportValidationErrorKind;
  readonly detail?: string;
  constructor(kind: ExportValidationErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'ExportValidationError';
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Parses `"1.0"` → `{ major: 1, minor: 0 }`. Throws on malformed input. */
export function parseSchemaVersion(raw: string): { major: number; minor: number } {
  const m = /^(\d+)\.(\d+)$/.exec(raw);
  if (!m) {
    throw new ExportValidationError(
      'malformed_schema_version',
      `schemaVersion "${raw}" is not in "<major>.<minor>" form`,
    );
  }
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Cheap structural check + major-version gate. Returns the document typed
 *  as `ExportDocument` on success; throws `ExportValidationError` otherwise.
 *  Deep field validation (node/edge shape) is left to the caller — the
 *  webview trusts the snapshot pipeline that already validates snapshots. */
export function assertCompatibleExport(raw: unknown): ExportDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExportValidationError('not_an_object', 'export document must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (typeof version !== 'string' || version.length === 0) {
    throw new ExportValidationError(
      'missing_schema_version',
      'export document is missing "schemaVersion"',
    );
  }
  const { major } = parseSchemaVersion(version);
  if (major !== EXPORT_SCHEMA_MAJOR) {
    throw new ExportValidationError(
      'incompatible_major',
      `export schema major v${major} is not supported by this build (expected v${EXPORT_SCHEMA_MAJOR})`,
      version,
    );
  }
  if (!obj.snapshot || typeof obj.snapshot !== 'object') {
    throw new ExportValidationError('missing_snapshot', 'export document is missing "snapshot"');
  }
  return obj as unknown as ExportDocument;
}

/** Convenience — build the mandatory envelope for a new export. Callers fill
 *  `snapshot`, then optionally attach `codeEdges` / `savedViews` / meta
 *  extras before serializing. */
export function createExportEnvelope(args: {
  snapshot: GraphSnapshot;
  producer: ExportProducer;
  producerVersion: string;
  sourceProject?: string;
  sourceProjectPath?: string;
  note?: string;
  now?: () => Date;
}): ExportDocument {
  const now = (args.now ?? (() => new Date()))();
  const meta: ExportMeta = {
    producer: args.producer,
    producerVersion: args.producerVersion,
  };
  if (args.sourceProject !== undefined) meta.sourceProject = args.sourceProject;
  if (args.sourceProjectPath !== undefined) meta.sourceProjectPath = args.sourceProjectPath;
  if (args.note !== undefined) meta.note = args.note;
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    meta,
    snapshot: args.snapshot,
  };
}
