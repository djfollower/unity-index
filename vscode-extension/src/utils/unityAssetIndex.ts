import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectContext, toRelativePath } from "../server/projectResolver";
import { executeDocumentSymbols } from "./lspBridge";
import { parseUnityYaml, UnityYamlDocument } from "./unityYaml";

const ASSET_EXTENSIONS = new Set([".prefab", ".unity", ".asset", ".mat", ".anim", ".controller", ".playable", ".spriteatlas", ".lighting"]);
const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"]);
const GUID_REGEX = /^guid:\s*([0-9a-fA-F]{32})\s*$/m;
const MB_HEADER_REGEX = /^---\s+!u!(\d+)\s+&(\d+)/;
const M_SCRIPT_GUID_REGEX = /m_Script:\s*\{[^}]*guid:\s*([0-9a-fA-F]{32})/;

/**
 * YAML keys that live on every MonoBehaviour regardless of the user script —
 * we never flag these as shadowed even if the script class doesn't declare
 * a field by that name.
 */
const MONOBEHAVIOUR_BUILTIN_KEYS = new Set([
  "m_ObjectHideFlags",
  "m_CorrespondingSourceObject",
  "m_PrefabInstance",
  "m_PrefabAsset",
  "m_GameObject",
  "m_Enabled",
  "m_EditorHideFlags",
  "m_Script",
  "m_Name",
  "m_EditorClassIdentifier",
]);

const YIELD_EVERY = 200;
const yieldEventLoop = () => new Promise<void>((r) => setImmediate(r));

export interface ComponentUsage {
  assetFile: string;
  gameObjectName: string | null;
  // Unity fileIDs are 64-bit and routinely exceed JS Number precision; keep
  // them as strings so MCP clients get the same digits Unity wrote.
  gameObjectFileId: string | null;
  fileId: string;
}

export interface ComponentUsageResult {
  typeName: string;
  scriptGuid: string | null;
  usages: ComponentUsage[];
  totalCount: number;
}

export interface EventBinding {
  assetFile: string;
  eventFieldPath: string;
  targetTypeName: string | null;
  methodName: string;
  gameObjectName: string | null;
  callState: number;
}

export interface EventBindingResult {
  methodName: string;
  bindings: EventBinding[];
  totalCount: number;
}

export interface SerializedFieldValue {
  assetFile: string;
  gameObjectName: string | null;
  value: string;
  fileId: string;
}

export interface SerializedFieldResult {
  typeName: string;
  fieldName: string;
  scriptGuid: string | null;
  values: SerializedFieldValue[];
  totalCount: number;
}

export interface AssetReference {
  assetFile: string;
  line: number;
  column: number;
  /** The nearest enclosing YAML key (e.g. "m_Sprite", "m_Material"). Best-effort. */
  fieldHint: string | null;
  /** Parsed from `fileID: N` on the same line, when present. */
  fileID: number | null;
  /** The trimmed line text for context. */
  context: string;
  /**
   * `true` when the hit sits inside a MonoBehaviour doc whose script class no
   * longer declares a serialized field named `fieldHint` — i.e. a dangling
   * YAML reference left behind after the field was removed from the script.
   * `null` when the determination wasn't possible (not under a MonoBehaviour,
   * no field hint, m_Script unresolved, or the script's symbols couldn't be
   * loaded).
   */
  shadowed: boolean | null;
}

export interface AssetReferenceResult {
  asset: { path: string | null; guid: string };
  references: AssetReference[];
  totalCount: number;
  truncated: boolean;
}

/**
 * Snapshot of the GUID map + asset-file list for a Unity project.
 *
 * Build it once via `UnityAssetIndex.build(project)` — the meta walk and
 * asset-file enumeration are the expensive parts and they are cached on the
 * instance. Per-query methods then iterate the cached asset-file list and
 * read each file lazily (async) so the event loop stays responsive on big
 * projects.
 *
 * Invalidation is the caller's responsibility — see `UnityAssetIndexManager`.
 */
export class UnityAssetIndex {
  private constructor(
    private readonly project: ProjectContext,
    private readonly guidToPath: Map<string, string>,
    private readonly pathToGuid: Map<string, string>,
    private readonly assetFiles: string[],
  ) {}

  static async build(
    project: ProjectContext,
    signal?: AbortSignal,
  ): Promise<UnityAssetIndex> {
    const guidToPath = new Map<string, string>();
    const pathToGuid = new Map<string, string>();
    const assetFiles: string[] = [];

    let counter = 0;
    const tick = async () => {
      if (++counter % YIELD_EVERY === 0) {
        await yieldEventLoop();
        if (signal?.aborted) throw new Error("UnityAssetIndex build aborted");
      }
    };

    await walkAsync(project.rootPath, async (entry, isDir) => {
      await tick();
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));

      if (entry.endsWith(".meta")) {
        await readMetaHeader(entry, guidToPath, pathToGuid);
      } else if (ASSET_EXTENSIONS.has(path.extname(entry))) {
        assetFiles.push(entry);
      }
      return true;
    });

    return new UnityAssetIndex(project, guidToPath, pathToGuid, assetFiles);
  }

  get assetCount(): number {
    return this.assetFiles.length;
  }

  get metaCount(): number {
    return this.guidToPath.size;
  }

  guidFor(assetPath: string): string | undefined {
    return this.pathToGuid.get(assetPath);
  }

  pathFor(guid: string): string | undefined {
    return this.guidToPath.get(guid);
  }

  /** Absolute paths of every indexed asset file, in walk order. */
  get assetFilePaths(): readonly string[] {
    return this.assetFiles;
  }

  /** (guid, absolutePath) for every script .meta indexed. */
  scriptGuids(): IterableIterator<[string, string]> {
    const scripts: Array<[string, string]> = [];
    for (const [guid, p] of this.guidToPath) {
      if (p.endsWith(".cs")) scripts.push([guid, p]);
    }
    return scripts.values();
  }

  /** Workspace context this index was built for. */
  get projectContext(): ProjectContext {
    return this.project;
  }

  async findComponentUsages(
    typeName: string,
    signal?: AbortSignal,
  ): Promise<ComponentUsageResult> {
    const scriptGuid = this.findScriptGuid(typeName);
    if (!scriptGuid) {
      return { typeName, scriptGuid: null, usages: [], totalCount: 0 };
    }

    const usages: ComponentUsage[] = [];
    await this.scanAssets(scriptGuid, signal, (file, docs) => {
      const gameObjects = collectGameObjects(docs);
      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        if (doc.getScriptGuid() !== scriptGuid) continue;
        const goFileId = doc.getGameObjectFileId();
        const goName =
          goFileId !== null
            ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null
            : null;
        usages.push({
          assetFile: toRelativePath(this.project, file),
          gameObjectName: goName,
          gameObjectFileId: goFileId,
          fileId: doc.fileId,
        });
      }
    });

    return { typeName, scriptGuid, usages, totalCount: usages.length };
  }

  async findEventBindings(
    methodName: string,
    signal?: AbortSignal,
  ): Promise<EventBindingResult> {
    const bindings: EventBinding[] = [];
    await this.scanAssets(methodName, signal, (file, docs) => {
      const gameObjects = collectGameObjects(docs);
      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        for (const call of doc.getPersistentCalls()) {
          if (call.methodName !== methodName) continue;
          const goFileId = doc.getGameObjectFileId();
          const goName =
            goFileId !== null
              ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null
              : null;
          bindings.push({
            assetFile: toRelativePath(this.project, file),
            eventFieldPath: findEventFieldName(doc, methodName) ?? "unknown",
            targetTypeName:
              call.targetAssemblyTypeName?.split(",")[0].trim() ?? null,
            methodName: call.methodName,
            gameObjectName: goName,
            callState: call.callState,
          });
        }
      }
    });
    return { methodName, bindings, totalCount: bindings.length };
  }

  async findSerializedFieldValues(
    typeName: string,
    fieldName: string,
    signal?: AbortSignal,
  ): Promise<SerializedFieldResult> {
    const scriptGuid = this.findScriptGuid(typeName);
    if (!scriptGuid) {
      return {
        typeName,
        fieldName,
        scriptGuid: null,
        values: [],
        totalCount: 0,
      };
    }

    // Pre-filter on both needles — script GUID and field name must appear.
    const values: SerializedFieldValue[] = [];
    await this.scanAssets([scriptGuid, fieldName], signal, (file, docs) => {
      const gameObjects = collectGameObjects(docs);
      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        if (doc.getScriptGuid() !== scriptGuid) continue;
        const v = doc.getSerializedFieldValue(fieldName);
        if (v === undefined) continue;
        const goFileId = doc.getGameObjectFileId();
        const goName =
          goFileId !== null
            ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null
            : null;
        values.push({
          assetFile: toRelativePath(this.project, file),
          gameObjectName: goName,
          value: v,
          fileId: doc.fileId,
        });
      }
    });

    return { typeName, fieldName, scriptGuid, values, totalCount: values.length };
  }

  /**
   * Find every place a GUID appears across asset YAML, with light context
   * extraction (enclosing field name + fileID on the same line). This is the
   * "paste the GUID into Find in Files" workflow, but cached and pre-filtered:
   * the substring check skips ~all assets cheaply, and YAML is never fully
   * parsed.
   *
   * Skips the asset's own .meta if the GUID resolves to a known asset.
   */
  async findAssetReferences(
    guid: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<AssetReferenceResult> {
    const ownPath = this.guidToPath.get(guid) ?? null;
    const references: AssetReference[] = [];
    let truncated = false;
    let counter = 0;
    const detector = new ShadowedFieldDetector(this.guidToPath);

    for (const file of this.assetFiles) {
      if (++counter % YIELD_EVERY === 0) {
        await yieldEventLoop();
        if (signal?.aborted) break;
      }
      if (ownPath && file === ownPath) continue;
      const content = await safeReadFile(file);
      if (content === null) continue;
      if (!content.includes(guid)) continue;

      const lines = content.split(/\r?\n/);
      const ranges = collectMonoBehaviourRanges(lines);
      const fileHits: { ref: AssetReference; scriptGuid: string | null }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const idx = line.indexOf(guid);
        if (idx < 0) continue;
        const fieldHint = enclosingKey(lines, i);
        const range = findEnclosingRange(ranges, i);
        const ref: AssetReference = {
          assetFile: toRelativePath(this.project, file),
          line: i + 1,
          column: idx + 1,
          fieldHint,
          fileID: parseFileIDOnLine(line),
          context: line.trim(),
          shadowed: null,
        };
        fileHits.push({ ref, scriptGuid: range?.scriptGuid ?? null });
        references.push(ref);
        if (references.length >= maxResults) {
          truncated = true;
          break;
        }
      }

      // Resolve shadowed flag for hits inside MonoBehaviour docs in this file.
      const scriptGuids = new Set<string>();
      for (const { ref, scriptGuid } of fileHits) {
        if (
          scriptGuid &&
          ref.fieldHint &&
          !MONOBEHAVIOUR_BUILTIN_KEYS.has(ref.fieldHint)
        ) {
          scriptGuids.add(scriptGuid);
        }
      }
      for (const sg of scriptGuids) {
        await detector.prefetch(sg);
        if (signal?.aborted) break;
      }
      for (const { ref, scriptGuid } of fileHits) {
        if (!scriptGuid || !ref.fieldHint) continue;
        if (MONOBEHAVIOUR_BUILTIN_KEYS.has(ref.fieldHint)) continue;
        ref.shadowed = detector.isShadowed(scriptGuid, ref.fieldHint);
      }

      if (truncated) break;
    }

    return {
      asset: {
        path: ownPath ? toRelativePath(this.project, ownPath) : null,
        guid,
      },
      references,
      totalCount: references.length,
      truncated,
    };
  }

  /**
   * Iterate every asset file once, applying a substring fast-path on each
   * needle before parsing the YAML. The visitor only runs for files where
   * every needle hits.
   */
  private async scanAssets(
    needles: string | string[],
    signal: AbortSignal | undefined,
    visit: (file: string, docs: UnityYamlDocument[]) => void,
  ): Promise<void> {
    const needleList = Array.isArray(needles) ? needles : [needles];
    let counter = 0;
    for (const file of this.assetFiles) {
      if (++counter % YIELD_EVERY === 0) {
        await yieldEventLoop();
        if (signal?.aborted) return;
      }
      const content = await safeReadFile(file);
      if (content === null) continue;
      let skip = false;
      for (const n of needleList) {
        if (!content.includes(n)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      try {
        const docs = parseUnityYaml(content, file);
        visit(file, docs);
      } catch {
        /* keep scanning */
      }
    }
  }

  private findScriptGuid(typeName: string): string | null {
    for (const [guid, p] of this.guidToPath) {
      if (!p.endsWith(".cs")) continue;
      const base = path.basename(p).replace(/\.cs$/, "");
      if (base === typeName) return guid;
    }
    for (const [guid, p] of this.guidToPath) {
      if (!p.endsWith(".cs")) continue;
      const base = path.basename(p).replace(/\.cs$/, "");
      if (base.toLowerCase() === typeName.toLowerCase()) return guid;
    }
    return null;
  }
}

async function readMetaHeader(
  metaPath: string,
  guidToPath: Map<string, string>,
  pathToGuid: Map<string, string>,
): Promise<void> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(metaPath, "r");
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const header = buf.toString("utf-8", 0, bytesRead);
    const m = GUID_REGEX.exec(header);
    if (!m) return;
    const assetPath = metaPath.slice(0, -5);
    guidToPath.set(m[1], assetPath);
    pathToGuid.set(assetPath, m[1]);
  } catch {
    /* ignore */
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function safeReadFile(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function walkAsync(
  root: string,
  visit: (entry: string, isDir: boolean) => Promise<boolean>,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    const full = path.join(root, dirent.name);
    const isDir = dirent.isDirectory();
    const descend = await visit(full, isDir);
    if (isDir && descend) {
      await walkAsync(full, visit);
    }
  }
}

function collectGameObjects(
  docs: UnityYamlDocument[],
): Map<string, UnityYamlDocument> {
  const out = new Map<string, UnityYamlDocument>();
  for (const d of docs) if (d.classId === 1) out.set(d.fileId, d);
  return out;
}

/**
 * Walk back from `lineIdx` to find the most recent line that looks like a YAML
 * key. Best-effort — Unity YAML is regular enough that the nearest preceding
 * `^(\s*)(\w[\w\d_]*):\s*$` line at a strictly smaller indent than the GUID's
 * own indent is almost always the field that owns the GUID reference.
 */
function enclosingKey(lines: string[], lineIdx: number): string | null {
  const guidLine = lines[lineIdx];
  const guidIndent = guidLine.length - guidLine.trimStart().length;
  const keyRe = /^(\s*)([A-Za-z_][\w]*):\s*(.*)$/;
  for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - 200; i--) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (indent >= guidIndent) continue;
    // Skip `m_Script: …` lines: those are the script type, not the field.
    if (m[2] === "m_Script" && m[3].length > 0) continue;
    return m[2];
  }
  return null;
}

interface MonoBehaviourRange {
  startLine: number;
  endLineExclusive: number;
  scriptGuid: string | null;
}

/**
 * Build line ranges for each MonoBehaviour (classId 114) document in the
 * file, capturing each doc's m_Script GUID. Used to attribute a GUID hit to
 * the user script whose field owns it.
 */
function collectMonoBehaviourRanges(lines: string[]): MonoBehaviourRange[] {
  const ranges: MonoBehaviourRange[] = [];
  let currentStart = -1;
  let currentIsMb = false;
  let currentScriptGuid: string | null = null;

  const close = (endExclusive: number) => {
    if (currentStart >= 0 && currentIsMb) {
      ranges.push({
        startLine: currentStart,
        endLineExclusive: endExclusive,
        scriptGuid: currentScriptGuid,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const header = MB_HEADER_REGEX.exec(lines[i]);
    if (header) {
      close(i);
      currentStart = i;
      currentIsMb = header[1] === "114";
      currentScriptGuid = null;
      continue;
    }
    if (currentIsMb && currentScriptGuid === null) {
      const m = M_SCRIPT_GUID_REGEX.exec(lines[i]);
      if (m) currentScriptGuid = m[1].toLowerCase();
    }
  }
  close(lines.length);
  return ranges;
}

function findEnclosingRange(
  ranges: MonoBehaviourRange[],
  lineIdx: number,
): MonoBehaviourRange | null {
  for (const r of ranges) {
    if (lineIdx >= r.startLine && lineIdx < r.endLineExclusive) return r;
  }
  return null;
}

/**
 * Decides whether `<scriptGuid, fieldName>` corresponds to a serialized field
 * that still exists on the script's class. Backed by the LSP document-symbol
 * provider so it reflects whatever Roslyn / C# Dev Kit sees — never a text
 * scan of the .cs source.
 *
 * `isShadowed` returns:
 * - `true` — class resolved AND `fieldName` is NOT among its members.
 * - `false` — class resolved AND `fieldName` IS among them.
 * - `null` — class couldn't be resolved (no .meta, file gone, LSP cold, etc.).
 *
 * Per-call cache keeps the symbol query to one per script.
 */
class ShadowedFieldDetector {
  private readonly cache = new Map<string, Set<string> | null>();

  constructor(private readonly guidToPath: Map<string, string>) {}

  async prefetch(scriptGuid: string): Promise<void> {
    if (this.cache.has(scriptGuid)) return;
    this.cache.set(scriptGuid, await this.resolve(scriptGuid));
  }

  isShadowed(scriptGuid: string, fieldName: string): boolean | null {
    const fields = this.cache.get(scriptGuid);
    if (fields === undefined || fields === null) return null;
    return !fields.has(fieldName);
  }

  private async resolve(scriptGuid: string): Promise<Set<string> | null> {
    const scriptPath = this.guidToPath.get(scriptGuid);
    if (!scriptPath || !scriptPath.endsWith(".cs")) return null;
    try {
      const uri = vscode.Uri.file(scriptPath);
      const symbols = await executeDocumentSymbols(uri);
      if (!symbols || symbols.length === 0) return null;
      const names = new Set<string>();
      collectMemberNames(symbols, names);
      return names;
    } catch {
      return null;
    }
  }
}

function collectMemberNames(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
  out: Set<string>,
): void {
  for (const sym of symbols) {
    const kind = sym.kind;
    if (
      kind === vscode.SymbolKind.Field ||
      kind === vscode.SymbolKind.Property ||
      kind === vscode.SymbolKind.Constant ||
      kind === vscode.SymbolKind.Variable ||
      kind === vscode.SymbolKind.EnumMember
    ) {
      out.add(stripSignature(sym.name));
    }
    const children = (sym as vscode.DocumentSymbol).children;
    if (children && children.length > 0) collectMemberNames(children, out);
  }
}

/**
 * Document symbol providers sometimes append type info to the name
 * (`fieldName : Sprite`, `fieldName(): void`). Trim that so we compare against
 * the raw YAML key.
 */
function stripSignature(raw: string): string {
  return raw.split(/[:\(]/, 1)[0].trim();
}

function parseFileIDOnLine(line: string): number | null {
  const m = /fileID:\s*(-?\d+)/.exec(line);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function findEventFieldName(
  doc: UnityYamlDocument,
  methodName: string,
): string | null {
  for (const [key, value] of doc.properties) {
    if (
      key.includes("m_PersistentCalls") &&
      key.endsWith(".m_MethodName") &&
      value === methodName
    ) {
      const idx = key.indexOf(".m_PersistentCalls");
      const eventPath = idx >= 0 ? key.slice(0, idx) : "";
      if (eventPath.length > 0 && eventPath !== key) return eventPath;
    }
  }
  return null;
}
