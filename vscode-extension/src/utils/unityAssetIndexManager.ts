import * as vscode from "vscode";
import { ProjectContext } from "../server/projectResolver";
import { UnityAssetIndex } from "./unityAssetIndex";

export type AssetIndexState = "idle" | "building" | "ready";

interface Entry {
  promise: Promise<UnityAssetIndex>;
  state: AssetIndexState;
  startedAt: number;
  readyAt?: number;
  index?: UnityAssetIndex;
  abort: AbortController;
}

export interface AssetIndexStatus {
  state: AssetIndexState;
  assetCount: number | null;
  metaCount: number | null;
  buildMs: number | null;
  lastInvalidatedAt: number | null;
}

const INVALIDATE_GLOB = "**/*.{meta,prefab,unity,asset,mat,anim,controller,playable,spriteatlas,lighting}";
const INVALIDATE_DEBOUNCE_MS = 500;

/**
 * Caches one UnityAssetIndex per workspace root, debounces invalidation when
 * relevant asset files change, and exposes a status snapshot for the
 * ide_index_status tool.
 *
 * `get()` returns the same in-flight build promise to concurrent callers, so
 * a burst of tool invocations during cold start only does one scan.
 */
export class UnityAssetIndexManager {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly invalidateTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastInvalidatedAt = new Map<string, number>();
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async get(project: ProjectContext): Promise<UnityAssetIndex> {
    const key = project.rootPath;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.startBuild(project);
      this.entries.set(key, entry);
      this.ensureWatcher(project);
    }
    return entry.promise;
  }

  status(project: ProjectContext): AssetIndexStatus {
    const key = project.rootPath;
    const entry = this.entries.get(key);
    const lastInvalidatedAt = this.lastInvalidatedAt.get(key) ?? null;
    if (!entry) {
      return {
        state: "idle",
        assetCount: null,
        metaCount: null,
        buildMs: null,
        lastInvalidatedAt,
      };
    }
    return {
      state: entry.state,
      assetCount: entry.index?.assetCount ?? null,
      metaCount: entry.index?.metaCount ?? null,
      buildMs:
        entry.readyAt !== undefined ? entry.readyAt - entry.startedAt : null,
      lastInvalidatedAt,
    };
  }

  invalidate(project: ProjectContext): void {
    this.invalidateKey(project.rootPath);
  }

  dispose(): void {
    for (const t of this.invalidateTimers.values()) clearTimeout(t);
    this.invalidateTimers.clear();
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
  }

  private startBuild(project: ProjectContext): Entry {
    const abort = new AbortController();
    const startedAt = Date.now();
    const entry: Entry = {
      promise: undefined as unknown as Promise<UnityAssetIndex>,
      state: "building",
      startedAt,
      abort,
    };
    entry.promise = UnityAssetIndex.build(project, abort.signal).then(
      (index) => {
        entry.index = index;
        entry.state = "ready";
        entry.readyAt = Date.now();
        this.log(
          `UnityAssetIndex(${project.name}) ready in ${entry.readyAt - startedAt}ms — ${index.assetCount} assets, ${index.metaCount} metas`,
        );
        return index;
      },
      (e) => {
        // Drop failed entry so the next call can retry.
        if (this.entries.get(project.rootPath) === entry) {
          this.entries.delete(project.rootPath);
        }
        throw e;
      },
    );
    return entry;
  }

  private ensureWatcher(project: ProjectContext): void {
    const key = project.rootPath;
    if (this.watchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(project.rootUri, INVALIDATE_GLOB),
    );
    const trigger = () => this.scheduleInvalidate(key);
    watcher.onDidCreate(trigger);
    watcher.onDidChange(trigger);
    watcher.onDidDelete(trigger);
    this.watchers.set(key, watcher);
  }

  private scheduleInvalidate(key: string): void {
    const existing = this.invalidateTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.invalidateTimers.delete(key);
      this.invalidateKey(key);
    }, INVALIDATE_DEBOUNCE_MS);
    this.invalidateTimers.set(key, timer);
  }

  private invalidateKey(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.abort.abort();
      this.entries.delete(key);
    }
    this.lastInvalidatedAt.set(key, Date.now());
    this.log(`UnityAssetIndex(${key}) invalidated`);
  }
}
