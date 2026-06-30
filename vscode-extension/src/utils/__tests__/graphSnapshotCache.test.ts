import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WARNING_DELTA_RESET } from "@unity-index/graph-core";
import { GraphSnapshotCache } from "../graphSnapshotCache";
import { AssetIndexLike } from "../unityAssetGraphBuilder";
import { ProjectContext } from "../../server/projectResolver";

// Vitest doesn't ship a vscode shim. The cache only needs ProjectContext,
// which carries a Uri; we stub Uri.file enough to satisfy the type.
vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
  },
}));

const HEX = "0123456789abcdef";
const guid = (seed: number): string => {
  let s = (seed >>> 0).toString(16).padStart(8, "0");
  while (s.length < 32) s = HEX[s.length % 16] + s;
  return s.slice(0, 32);
};

interface FixtureFile {
  rel: string;
  content: string;
  guid?: string;
}

function setup(files: FixtureFile[]): {
  root: string;
  index: AssetIndexLike;
  project: ProjectContext;
  rewrite: (files: FixtureFile[]) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cache-"));

  const assetFiles = new Set<string>();
  const guidToPath = new Map<string, string>();
  const pathToGuid = new Map<string, string>();

  const write = (files: FixtureFile[]) => {
    for (const f of files) {
      const full = path.join(root, f.rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, "utf-8");
      if (f.guid) {
        const meta = `fileFormatVersion: 2\nguid: ${f.guid}\n`;
        fs.writeFileSync(`${full}.meta`, meta, "utf-8");
        guidToPath.set(f.guid, full);
        pathToGuid.set(full, f.guid);
      }
      if (
        [".prefab", ".unity", ".asset"].includes(
          path.extname(full).toLowerCase(),
        )
      ) {
        assetFiles.add(full);
      }
    }
  };
  write(files);

  const index: AssetIndexLike = {
    scriptGuids() {
      const items: Array<[string, string]> = [];
      for (const [g, p] of guidToPath) {
        if (p.endsWith(".cs")) items.push([g, p]);
      }
      return items.values();
    },
    get assetFilePaths() {
      return Array.from(assetFiles);
    },
    guidFor(p) {
      return pathToGuid.get(p);
    },
  };

  const project: ProjectContext = {
    rootUri: vscode.Uri.file(root),
    name: path.basename(root),
    rootPath: root,
  };

  return {
    root,
    index,
    project,
    rewrite: write,
  };
}

const NOOP_LOG = () => {};

describe("GraphSnapshotCache — lifecycle", () => {
  let root: string;
  afterEach(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cold cache seeds at revision 0 on first snapshot read", async () => {
    const fx = setup([
      {
        rel: "Assets/Scripts/Player.cs",
        content: "// stub\n",
        guid: guid(1),
      },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    const resp = await cache.getSnapshot(fx.project, fx.index, {} as any);
    expect(resp.revision).toBe(0);
    expect(resp.snapshot.nodes.length).toBeGreaterThan(0);
  });

  it("returns reset:true with full snapshot when the cache is cold", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/X.cs", content: "// stub\n", guid: guid(2) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    const resp = await cache.getDelta(fx.project, fx.index, {
      project_path: fx.root,
      since_revision: 5,
    });
    expect(resp.reset).toBe(true);
    expect(resp.snapshot).toBeDefined();
    expect(resp.warnings?.[0]?.code).toBe(WARNING_DELTA_RESET);
    expect(resp.warnings?.[0]?.context).toMatchObject({
      reason: "server_restart",
    });
  });

  it("notifyChanged with no real change does not bump the revision", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/A.cs", content: "// a\n", guid: guid(3) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    const first = await cache.getSnapshot(fx.project, fx.index, {} as any);
    expect(first.revision).toBe(0);

    // No filesystem change, just a spurious watcher event.
    await cache.notifyChanged(fx.project, fx.index, ["Assets/Scripts/A.cs"]);

    const second = await cache.getSnapshot(fx.project, fx.index, {} as any);
    expect(second.revision).toBe(0);
  });

  it("a real script add bumps the revision and produces a delta", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/A.cs", content: "// a\n", guid: guid(4) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    const first = await cache.getSnapshot(fx.project, fx.index, {} as any);
    expect(first.revision).toBe(0);

    // Add a second script under Assets/ and notify.
    fx.rewrite([
      { rel: "Assets/Scripts/B.cs", content: "// b\n", guid: guid(5) },
    ]);
    await cache.notifyChanged(fx.project, fx.index, ["Assets/Scripts/B.cs"]);

    const second = await cache.getSnapshot(fx.project, fx.index, {} as any);
    expect(second.revision).toBe(1);

    const delta = await cache.getDelta(fx.project, fx.index, {
      project_path: fx.root,
      since_revision: 0,
    });
    expect(delta.reset).toBe(false);
    expect(delta.new_revision).toBe(1);
    expect(delta.delta).toBeDefined();
    // The new script's node should appear in nodes_added.
    const addedIds = delta.delta!.nodes_added.map((n) => n.id);
    expect(addedIds.some((id) => id.includes("B.cs"))).toBe(true);
  });

  it("returns an empty delta when client revision matches current", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/A.cs", content: "// a\n", guid: guid(6) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    await cache.getSnapshot(fx.project, fx.index, {} as any);
    const resp = await cache.getDelta(fx.project, fx.index, {
      project_path: fx.root,
      since_revision: 0,
    });
    expect(resp.reset).toBe(false);
    expect(resp.delta).toBeDefined();
    expect(resp.delta!.nodes_added).toEqual([]);
    expect(resp.delta!.nodes_removed).toEqual([]);
    expect(resp.delta!.nodes_updated).toEqual([]);
    expect(resp.delta!.edges_added).toEqual([]);
    expect(resp.delta!.edges_removed).toEqual([]);
    expect(resp.new_revision).toBe(0);
  });

  it("filtered delta requests reset with filter_mismatch reason", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/A.cs", content: "// a\n", guid: guid(7) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    await cache.getSnapshot(fx.project, fx.index, {} as any);
    const resp = await cache.getDelta(fx.project, fx.index, {
      project_path: fx.root,
      since_revision: 0,
      include_kinds: ["prefab"],
    });
    expect(resp.reset).toBe(true);
    expect(resp.warnings?.[0]?.context).toMatchObject({
      reason: "filter_mismatch",
    });
  });

  it("after two real changes, a client at revision N-2 gets history_exhausted reset", async () => {
    const fx = setup([
      { rel: "Assets/Scripts/A.cs", content: "// a\n", guid: guid(8) },
    ]);
    root = fx.root;
    const cache = new GraphSnapshotCache(NOOP_LOG);

    await cache.getSnapshot(fx.project, fx.index, {} as any);
    fx.rewrite([
      { rel: "Assets/Scripts/B.cs", content: "// b\n", guid: guid(9) },
    ]);
    await cache.notifyChanged(fx.project, fx.index, ["Assets/Scripts/B.cs"]);
    fx.rewrite([
      { rel: "Assets/Scripts/C.cs", content: "// c\n", guid: guid(10) },
    ]);
    await cache.notifyChanged(fx.project, fx.index, ["Assets/Scripts/C.cs"]);

    const resp = await cache.getDelta(fx.project, fx.index, {
      project_path: fx.root,
      since_revision: 0,
    });
    expect(resp.reset).toBe(true);
    expect(resp.warnings?.[0]?.context).toMatchObject({
      reason: "history_exhausted",
    });
    expect(resp.new_revision).toBe(2);
  });
});
