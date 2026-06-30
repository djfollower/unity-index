import * as vscode from "vscode";
import type {
  CodeEdgeKind,
  CodeEdgesRequest,
  CodeEdgesResponse,
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  MethodCallKind,
  MethodCallSite,
  NodeKind,
} from "@unity-index/graph-core";
import { CODE_EDGES_MAX_SYMBOLS } from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext, fromPosition } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import {
  callHierarchyOutgoing,
  executeReferences,
  executeWorkspaceSymbols,
  prepareCallHierarchy,
  prepareTypeHierarchy,
  typeHierarchySupertypes,
} from "../../utils/lspBridge";

const CSHARP_PREFIX = "unity://csharp/";
const ALL_KINDS: CodeEdgeKind[] = [
  "class_inherits_from",
  "class_implements_interface",
  "method_overrides_method",
  "method_calls_method",
  "class_references_class",
];

const TYPE_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);

const METHOD_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

interface ResolvedSymbol {
  inputId: string;
  docKind: "T" | "M";
  /** Last simple segment used for workspace symbol lookup. */
  simpleName: string;
  /** Best-effort fully-qualified-ish name, used to mint deterministic target IDs. */
  fqn: string;
  uri: vscode.Uri;
  position: vscode.Position;
  vscodeKind: vscode.SymbolKind;
}

/**
 * Day-8 MCP surface — see graph-mcp-tools.md §3.6 and graph-schema.md §1/§3.
 * Batches C# edge lookups (inheritance, overrides, calls, references) for up
 * to CODE_EDGES_MAX_SYMBOLS unity://csharp/... symbol IDs. TS mirror of
 * Rider's UnityGraphCodeEdgesTool — wire shape is byte-for-byte identical.
 */
export class UnityGraphCodeEdgesTool extends AbstractMcpTool {
  // C# Dev Kit / Roslyn LSP must be ready before we can resolve symbol IDs.
  protected readonly requiresLsp = true;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_CODE_EDGES;
  readonly description =
    "Batch C# semantic-edge lookup for N unity://csharp/... symbol IDs (1.." +
    `${CODE_EDGES_MAX_SYMBOLS}). Returns inheritance, override, call, and reference edges via Roslyn LSP, ` +
    "optionally bundling target nodes for one-shot rendering. Stale or unresolved IDs are reported in " +
    "unresolved_ids (partial success).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property(
      "symbol_ids",
      {
        type: "array",
        description: `1..${CODE_EDGES_MAX_SYMBOLS} unity://csharp/<DocId> IDs (e.g. 'unity://csharp/T:Foo.Bar', 'unity://csharp/M:Foo.Bar.Baz(System.Int32)').`,
        items: { type: "string" },
      },
      true,
    )
    .property("edge_kinds", {
      type: "array",
      description:
        "Restrict to these CodeEdgeKinds. Omit/empty for all. " +
        "Allowed: class_inherits_from | class_implements_interface | method_overrides_method | method_calls_method | class_references_class.",
      items: { type: "string" },
    })
    .booleanProperty(
      "include_targets",
      "Default true. When false, snapshot.nodes is empty (caller has them).",
    )
    .stringProperty(
      "request_id",
      "Optional; echoed back on the response for client correlation.",
    )
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    _ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const request = args as unknown as CodeEdgesRequest;
    const validation = validateCodeEdgesRequest(request);
    if (validation) return this.structuredError(validation);
    const response = await harvestCodeEdges(project.rootPath, request);
    return this.json(response);
  }
}

/**
 * Day 8.5 — shared harvest pipeline so the webview bridge handler can call
 * the same code path as the MCP tool without dragging in the
 * AbstractMcpTool / ToolContext machinery (readiness gate, etc.). The
 * bridge handler runs interactively in response to a user click — readiness
 * is implied. Validation errors throw `Error("invalid_id: ...")` so the
 * bridge surfaces a stable string to the webview; the MCP tool path
 * validates separately to produce its structured-error envelope.
 */
export async function harvestCodeEdges(
  rootPath: string,
  request: CodeEdgesRequest,
): Promise<CodeEdgesResponse> {
  const validation = validateCodeEdgesRequest(request);
  if (validation) {
    const e = validation.error;
    throw new Error(`${e.kind}: ${e.detail}`);
  }
  const ids = request.symbol_ids;
  const includeTargets = request.include_targets !== false;
  const kindFilter = new Set<CodeEdgeKind>(
    request.edge_kinds && request.edge_kinds.length > 0
      ? request.edge_kinds
      : ALL_KINDS,
  );

  const unresolvedIds: string[] = [];
  const edges = new Map<string, GraphEdge>();
  const targetNodes = new Map<string, GraphNode>();

  for (const id of ids) {
    const resolved = await resolveSymbol(id, rootPath);
    if (!resolved) {
      unresolvedIds.push(id);
      continue;
    }
    if (
      kindFilter.has("class_inherits_from") ||
      kindFilter.has("class_implements_interface") ||
      kindFilter.has("method_overrides_method")
    ) {
      await collectSupertypeEdges(resolved, kindFilter, edges, targetNodes);
    }
    if (kindFilter.has("method_calls_method") && resolved.docKind === "M") {
      await collectOutgoingCalls(resolved, edges, targetNodes);
    }
    if (kindFilter.has("class_references_class") && resolved.docKind === "T") {
      await collectClassReferences(resolved, edges, targetNodes);
    }
  }

  const snapshot: GraphSnapshot = {
    nodes: includeTargets ? Array.from(targetNodes.values()) : [],
    edges: Array.from(edges.values()),
    generated_at: new Date().toISOString(),
    source_phase: "code",
    stats: {
      node_count: includeTargets ? targetNodes.size : 0,
      edge_count: edges.size,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
  };
  const response: CodeEdgesResponse = {
    generated_at: snapshot.generated_at,
    snapshot,
  };
  if (unresolvedIds.length > 0) response.unresolved_ids = unresolvedIds;
  if (request.request_id !== undefined) response.request_id = request.request_id;
  return response;
}

function validateCodeEdgesRequest(
  request: CodeEdgesRequest,
): { error: { kind: "invalid_id"; detail: string } } | undefined {
  const ids = Array.isArray(request.symbol_ids) ? request.symbol_ids : [];
  if (ids.length === 0) {
    return {
      error: { kind: "invalid_id", detail: "symbol_ids must contain at least one entry" },
    };
  }
  if (ids.length > CODE_EDGES_MAX_SYMBOLS) {
    return {
      error: {
        kind: "invalid_id",
        detail: `symbol_ids exceeds ${CODE_EDGES_MAX_SYMBOLS} (got ${ids.length})`,
      },
    };
  }
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith(CSHARP_PREFIX)) {
      return {
        error: {
          kind: "invalid_id",
          detail: `symbol_ids entry '${id}' is not a 'unity://csharp/...' ID`,
        },
      };
    }
  }
  return undefined;
}

/** Strip the `unity://csharp/` prefix and split into DocId kind + body. */
function parseDocId(id: string): { docKind: "T" | "M"; body: string } | undefined {
  const tail = id.slice(CSHARP_PREFIX.length);
  if (tail.startsWith("T:")) return { docKind: "T", body: tail.slice(2) };
  if (tail.startsWith("M:")) return { docKind: "M", body: tail.slice(2) };
  // The wire schema only mints T:/M: for graph node IDs; F:/P:/E: aren't part
  // of the contract today. Treat anything else as unresolvable.
  return undefined;
}

/** Extract the unqualified short name workspace-symbol search needs. */
function shortNameOf(docKind: "T" | "M", body: string): {
  simpleName: string;
  fqn: string;
} {
  // For methods: strip the parameter list "(...)" and arity "`N".
  let typePath = body;
  if (docKind === "M") {
    const parenIdx = body.indexOf("(");
    typePath = parenIdx >= 0 ? body.slice(0, parenIdx) : body;
  }
  // Drop generic arity (e.g. "Foo`1.Bar").
  typePath = typePath.replace(/`\d+/g, "");
  const lastDot = typePath.lastIndexOf(".");
  const simpleName = lastDot >= 0 ? typePath.slice(lastDot + 1) : typePath;
  return { simpleName, fqn: typePath };
}

async function resolveSymbol(
  id: string,
  projectRoot: string,
): Promise<ResolvedSymbol | undefined> {
  const parsed = parseDocId(id);
  if (!parsed) return undefined;
  const { simpleName, fqn } = shortNameOf(parsed.docKind, parsed.body);
  if (!simpleName) return undefined;
  const candidates = await executeWorkspaceSymbols(simpleName);
  const wanted = parsed.docKind === "T" ? TYPE_SYMBOL_KINDS : METHOD_SYMBOL_KINDS;
  // Prefer symbols inside the project root + matching the FQN tail.
  const scored = candidates
    .filter((s) => wanted.has(s.kind) && s.name.startsWith(simpleName))
    .map((s) => ({
      sym: s,
      score: scoreCandidate(s, fqn, projectRoot),
    }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.sym;
  if (!top) return undefined;
  return {
    inputId: id,
    docKind: parsed.docKind,
    simpleName,
    fqn,
    uri: top.location.uri,
    position: top.location.range.start,
    vscodeKind: top.kind,
  };
}

function scoreCandidate(
  s: vscode.SymbolInformation,
  fqn: string,
  projectRoot: string,
): number {
  let score = 0;
  if (s.location.uri.fsPath.startsWith(projectRoot)) score += 10;
  const container = (s.containerName ?? "").replace(/`\d+/g, "");
  const want = fqn.includes(".")
    ? fqn.slice(0, fqn.lastIndexOf("."))
    : "";
  if (want && container && (container === want || want.endsWith(container))) {
    score += 5;
  }
  return score;
}

/** Walk supertypes; classify as inherits (class), implements (interface), or override (method). */
async function collectSupertypeEdges(
  src: ResolvedSymbol,
  kindFilter: Set<CodeEdgeKind>,
  edges: Map<string, GraphEdge>,
  targetNodes: Map<string, GraphNode>,
): Promise<void> {
  const roots = await prepareTypeHierarchy(src.uri, src.position);
  if (roots.length === 0) return;
  for (const root of roots) {
    const supers = await typeHierarchySupertypes(root);
    for (const sup of supers) {
      const isMethod = METHOD_SYMBOL_KINDS.has(sup.kind);
      const isInterface = sup.kind === vscode.SymbolKind.Interface;
      let edgeKind: CodeEdgeKind | undefined;
      if (src.docKind === "M" && isMethod) {
        edgeKind = "method_overrides_method";
      } else if (src.docKind === "T") {
        edgeKind = isInterface ? "class_implements_interface" : "class_inherits_from";
      }
      if (!edgeKind || !kindFilter.has(edgeKind)) continue;
      const targetId = mintCsharpId(sup, isMethod ? "M" : "T");
      addEdge(edges, src.inputId, targetId, edgeKind, {});
      addTargetNode(targetNodes, targetId, sup);
    }
  }
}

async function collectOutgoingCalls(
  src: ResolvedSymbol,
  edges: Map<string, GraphEdge>,
  targetNodes: Map<string, GraphNode>,
): Promise<void> {
  const items = await prepareCallHierarchy(src.uri, src.position);
  if (items.length === 0) return;
  // Aggregate call sites by target so each target produces one edge.
  const sitesByTarget = new Map<
    string,
    { item: vscode.CallHierarchyItem; sites: MethodCallSite[] }
  >();
  for (const root of items) {
    const outgoing = await callHierarchyOutgoing(root);
    for (const call of outgoing) {
      const targetId = mintCsharpId(call.to, "M");
      const entry =
        sitesByTarget.get(targetId) ?? { item: call.to, sites: [] };
      for (const range of call.fromRanges) {
        // TODO(vscode-extension/src/tools/unity/unityGraphCodeEdgesTool.ts:~XXX):
        // VS Code's CallHierarchyOutgoingCall doesn't expose whether the call
        // site is direct/virtual/interface/delegate. Roslyn LSP doesn't surface
        // that metadata through the call hierarchy provider today, so we
        // default to 'direct'. Day 8.6 (tests) should pin this and Day 9+
        // could refine via a follow-up SemanticTokens or hover probe.
        const kind: MethodCallKind = "direct";
        entry.sites.push({ line: fromPosition(range.start).line, kind });
      }
      sitesByTarget.set(targetId, entry);
    }
  }
  for (const [targetId, { item, sites }] of sitesByTarget) {
    addEdge(edges, src.inputId, targetId, "method_calls_method", {
      call_sites: dedupeSites(sites),
    });
    addTargetNode(targetNodes, targetId, item);
  }
}

/** A reference to a type from another type declaration site (filtered). */
async function collectClassReferences(
  src: ResolvedSymbol,
  edges: Map<string, GraphEdge>,
  targetNodes: Map<string, GraphNode>,
): Promise<void> {
  const refs = await executeReferences(src.uri, src.position);
  for (const loc of refs) {
    // Skip self-references inside the declaring file at the same line.
    if (
      loc.uri.toString() === src.uri.toString() &&
      loc.range.start.line === src.position.line
    ) {
      continue;
    }
    // Filter to references that fall inside another type declaration. We use
    // workspace-symbol membership as the cheapest signal Roslyn LSP exposes;
    // a tighter document-symbol scan can land in 8.6.
    const containingType = await findEnclosingType(loc);
    if (!containingType) continue;
    const targetId = mintCsharpId(containingType, "T");
    if (targetId === src.inputId) continue;
    addEdge(edges, targetId, src.inputId, "class_references_class", {});
    addTargetNode(targetNodes, targetId, containingType);
  }
}

async function findEnclosingType(
  loc: vscode.Location,
): Promise<vscode.SymbolInformation | undefined> {
  // Pull every type symbol Roslyn knows about in this file and pick the one
  // whose range covers `loc`. executeWorkspaceSymbols('') returns nothing on
  // Roslyn, so we use executeDocumentSymbolProvider instead.
  const docSyms = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[]
  >("vscode.executeDocumentSymbolProvider", loc.uri);
  if (!docSyms || docSyms.length === 0) return undefined;
  // DocumentSymbol[] tree → flatten and pick the innermost type covering loc.
  const flat: { sym: vscode.DocumentSymbol; }[] = [];
  function walk(items: vscode.DocumentSymbol[]): void {
    for (const it of items) {
      flat.push({ sym: it });
      if (it.children) walk(it.children);
    }
  }
  if (Array.isArray(docSyms) && docSyms.length > 0 && "children" in docSyms[0]) {
    walk(docSyms as vscode.DocumentSymbol[]);
  } else {
    // SymbolInformation[] — best we can do is range containment by location.
    const flatInfo = (docSyms as vscode.SymbolInformation[]).filter((s) =>
      TYPE_SYMBOL_KINDS.has(s.kind) && s.location.range.contains(loc.range),
    );
    return flatInfo[0];
  }
  const candidates = flat
    .filter((f) => TYPE_SYMBOL_KINDS.has(f.sym.kind))
    .filter((f) => f.sym.range.contains(loc.range));
  if (candidates.length === 0) return undefined;
  // Innermost wins.
  const innermost = candidates.reduce((best, cur) =>
    best.sym.range.contains(cur.sym.range) ? cur : best,
  );
  return new vscode.SymbolInformation(
    innermost.sym.name,
    innermost.sym.kind,
    "",
    new vscode.Location(loc.uri, innermost.sym.selectionRange.start),
  );
}

function mintCsharpId(
  item: { name: string; detail?: string },
  docKind: "T" | "M",
): string {
  // The VS Code LSP doesn't surface DocumentationCommentId, so we fall back to
  // the symbol's display name. This is intentionally lossy: T:Name collides
  // across namespaces and M:Name(...) collides across overloads. Day 8.6 tests
  // pin the current behavior; a follow-up could request the LSP's
  // `roslyn/documentationId` if/when C# Dev Kit exposes it.
  return `${CSHARP_PREFIX}${docKind}:${item.name}`;
}

function addEdge(
  edges: Map<string, GraphEdge>,
  source: string,
  target: string,
  kind: CodeEdgeKind,
  metadata: Record<string, unknown>,
): void {
  const key = `${source}${target}${kind}`;
  if (edges.has(key)) {
    // Merge call_sites when re-adding the same edge from a different code path.
    if (kind === "method_calls_method" && Array.isArray(metadata.call_sites)) {
      const existing = edges.get(key)!;
      const prev = (existing.metadata.call_sites as MethodCallSite[] | undefined) ?? [];
      existing.metadata.call_sites = dedupeSites([
        ...prev,
        ...(metadata.call_sites as MethodCallSite[]),
      ]);
    }
    return;
  }
  edges.set(key, {
    source,
    target,
    kind: kind as EdgeKind,
    metadata,
  });
}

function dedupeSites(sites: MethodCallSite[]): MethodCallSite[] {
  const seen = new Set<string>();
  const out: MethodCallSite[] = [];
  for (const s of sites) {
    const key = `${s.line}${s.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function addTargetNode(
  nodes: Map<string, GraphNode>,
  id: string,
  item: { name: string; kind: vscode.SymbolKind; uri?: vscode.Uri; detail?: string },
): void {
  if (nodes.has(id)) return;
  const nodeKind = mapNodeKind(item.kind);
  const node: GraphNode = {
    id,
    kind: nodeKind,
    label: item.name,
    metadata: {},
  };
  if (item.uri) node.path = item.uri.fsPath;
  if (item.detail) node.metadata.detail = item.detail;
  nodes.set(id, node);
}

function mapNodeKind(k: vscode.SymbolKind): NodeKind {
  switch (k) {
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Struct:
      return "struct";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Constructor:
      return "method";
    case vscode.SymbolKind.Property:
      return "property";
    case vscode.SymbolKind.Field:
      return "field";
    default:
      return "class";
  }
}
