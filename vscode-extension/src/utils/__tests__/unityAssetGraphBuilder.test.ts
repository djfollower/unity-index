import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphEdge, SnapshotRequest } from "@unity-index/graph-core";
import {
  AssetIndexLike,
  buildAssetGraph,
} from "../unityAssetGraphBuilder";

// 32-char hex GUIDs for the fixtures. Choosing distinct prefixes makes
// diffs easier to read than random hex.
const GUID = {
  scriptPlayer: "a1".repeat(16),
  scriptEnemy: "a2".repeat(16),
  prefabPlayer: "b1".repeat(16),
  prefabBase: "b2".repeat(16),
  prefabVariant: "b3".repeat(16),
  scene: "c1".repeat(16),
  so: "d1".repeat(16),
  bulletPrefab: "e1".repeat(16),
  orphanSo: "f1".repeat(16),
  inScopePrefab: "11".repeat(16),
  outOfScopePrefab: "22".repeat(16),
};

interface FixtureFile {
  /** Relative path under the fixture root. */
  rel: string;
  content: string;
  /** When set, a sibling .meta file is written with this GUID. */
  guid?: string;
}

const ASSET_EXTS = new Set([
  ".prefab",
  ".unity",
  ".asset",
  ".mat",
  ".anim",
  ".controller",
]);

function setupFixture(files: FixtureFile[]): {
  root: string;
  index: AssetIndexLike;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-graph-"));
  const assetFiles: string[] = [];
  const guidToPath = new Map<string, string>();
  const pathToGuid = new Map<string, string>();
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
    if (ASSET_EXTS.has(path.extname(full).toLowerCase())) {
      assetFiles.push(full);
    }
  }
  const index: AssetIndexLike = {
    scriptGuids() {
      const items: Array<[string, string]> = [];
      for (const [guid, p] of guidToPath) {
        if (p.endsWith(".cs")) items.push([guid, p]);
      }
      return items.values();
    },
    get assetFilePaths() {
      return assetFiles;
    },
    guidFor(p) {
      return pathToGuid.get(p);
    },
  };
  return { root, index };
}

function script(guid: string, rel: string): FixtureFile {
  return { rel, content: "// fixture script\n", guid };
}

function prefabWithComponent(
  guid: string,
  rel: string,
  scriptGuid: string,
): FixtureFile {
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!1 &100\n` +
    `GameObject:\n` +
    `  m_Name: Player\n` +
    `--- !u!114 &200\n` +
    `MonoBehaviour:\n` +
    `  m_GameObject: {fileID: 100}\n` +
    `  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}\n` +
    `  m_Name: \n`;
  return { rel, content, guid };
}

function scene(
  guid: string,
  rel: string,
  prefabSourceGuid: string,
): FixtureFile {
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!29 &1\n` +
    `OcclusionCullingSettings:\n` +
    `  m_ObjectHideFlags: 0\n` +
    `--- !u!1001 &300\n` +
    `PrefabInstance:\n` +
    `  m_ObjectHideFlags: 0\n` +
    `  m_SourcePrefab: {fileID: 100100000, guid: ${prefabSourceGuid}, type: 3}\n`;
  return { rel, content, guid };
}

function scriptableObject(
  guid: string,
  rel: string,
  scriptGuid: string,
): FixtureFile {
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!114 &11400000\n` +
    `MonoBehaviour:\n` +
    `  m_ObjectHideFlags: 0\n` +
    `  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}\n` +
    `  m_Name: Config\n`;
  return { rel, content, guid };
}

function prefabWithBindings(
  guid: string,
  rel: string,
  scriptGuid: string,
  targetGuid: string,
  fieldCount: number,
): FixtureFile {
  let fields = "";
  for (let i = 0; i < fieldCount; i++) {
    fields += `  field${i}: {fileID: 100100000, guid: ${targetGuid}, type: 3}\n`;
  }
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!1 &100\n` +
    `GameObject:\n` +
    `  m_Name: Owner\n` +
    `--- !u!114 &200\n` +
    `MonoBehaviour:\n` +
    `  m_GameObject: {fileID: 100}\n` +
    `  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}\n` +
    fields;
  return { rel, content, guid };
}

function prefabVariant(
  guid: string,
  rel: string,
  basePrefabGuid: string,
): FixtureFile {
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!1001 &900\n` +
    `PrefabInstance:\n` +
    `  m_ObjectHideFlags: 0\n` +
    `  m_SourcePrefab: {fileID: 100100000, guid: ${basePrefabGuid}, type: 3}\n`;
  return { rel, content, guid };
}

function plainPrefab(guid: string, rel: string): FixtureFile {
  const content =
    `%YAML 1.1\n` +
    `%TAG !u! tag:unity3d.com,2011:\n` +
    `--- !u!1 &100\n` +
    `GameObject:\n` +
    `  m_Name: Base\n`;
  return { rel, content, guid };
}

const emptyRequest: SnapshotRequest = { project_path: "" };

const tempRoots: string[] = [];

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(() => {
  for (const r of tempRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function setup(files: FixtureFile[]) {
  const { root, index } = setupFixture(files);
  tempRoots.push(root);
  return { root, index };
}

function findEdge(
  edges: readonly GraphEdge[],
  source: string,
  target: string,
  kind: string,
): GraphEdge | undefined {
  return edges.find(
    (e) => e.source === source && e.target === target && e.kind === kind,
  );
}

describe("buildAssetGraph", () => {
  it("emits nodes + edges for the happy-path 4-asset toy project", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/Scripts/Player.cs"),
      prefabWithComponent(
        GUID.prefabPlayer,
        "Assets/Prefabs/Player.prefab",
        GUID.scriptPlayer,
      ),
      scene(GUID.scene, "Assets/Scenes/Main.unity", GUID.prefabPlayer),
      scriptableObject(GUID.so, "Assets/Config.asset", GUID.scriptPlayer),
    ]);

    const res = await buildAssetGraph(root, index, emptyRequest);
    const { nodes, edges, stats, source_phase } = res.snapshot;

    expect(source_phase).toBe("asset");
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids).toContain("unity://script/Assets/Scripts/Player.cs");
    expect(ids).toContain(`unity://prefab/${GUID.prefabPlayer}`);
    expect(ids).toContain(`unity://scene/${GUID.scene}`);
    expect(ids).toContain(`unity://so/${GUID.so}`);

    expect(
      findEdge(
        edges,
        "unity://script/Assets/Scripts/Player.cs",
        `unity://prefab/${GUID.prefabPlayer}`,
        "script_used_by_prefab",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        edges,
        `unity://scene/${GUID.scene}`,
        `unity://prefab/${GUID.prefabPlayer}`,
        "scene_contains_prefab",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        edges,
        "unity://script/Assets/Scripts/Player.cs",
        "unity://csharp/T:Player",
        "script_declares_class",
      ),
    ).toBeDefined();

    expect(stats.node_count).toBe(nodes.length);
    expect(stats.edge_count).toBe(edges.length);
  });

  it("marks .prefab with PrefabInstance docs as prefab_variant + emits prefab_variant_of", async () => {
    const { root, index } = setup([
      plainPrefab(GUID.prefabBase, "Assets/Prefabs/Base.prefab"),
      prefabVariant(
        GUID.prefabVariant,
        "Assets/Prefabs/Variant.prefab",
        GUID.prefabBase,
      ),
    ]);

    const res = await buildAssetGraph(root, index, emptyRequest);
    const variantNode = res.snapshot.nodes.find(
      (n) => n.id === `unity://prefab/${GUID.prefabVariant}`,
    );
    expect(variantNode?.kind).toBe("prefab_variant");
    expect(
      findEdge(
        res.snapshot.edges,
        `unity://prefab/${GUID.prefabVariant}`,
        `unity://prefab/${GUID.prefabBase}`,
        "prefab_variant_of",
      ),
    ).toBeDefined();
  });

  it("aggregates serialized_binding per (owner,target) — 3 fields collapse to 1 edge with bindings.length=3", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/Scripts/Owner.cs"),
      plainPrefab(GUID.bulletPrefab, "Assets/Prefabs/Bullet.prefab"),
      prefabWithBindings(
        GUID.prefabPlayer,
        "Assets/Prefabs/Owner.prefab",
        GUID.scriptPlayer,
        GUID.bulletPrefab,
        3,
      ),
    ]);

    const res = await buildAssetGraph(root, index, emptyRequest);
    const bindingEdges = res.snapshot.edges.filter(
      (e) => e.kind === "serialized_binding",
    );
    expect(bindingEdges).toHaveLength(1);
    const [edge] = bindingEdges;
    expect(edge.source).toBe(`unity://prefab/${GUID.prefabPlayer}`);
    expect(edge.target).toBe(`unity://prefab/${GUID.bulletPrefab}`);
    const bindings = edge.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(3);
  });

  it("warns subfile_kind_ignored when component_instance/component_field are requested", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/Scripts/Player.cs"),
      prefabWithComponent(
        GUID.prefabPlayer,
        "Assets/Prefabs/Player.prefab",
        GUID.scriptPlayer,
      ),
    ]);
    const res = await buildAssetGraph(root, index, {
      ...emptyRequest,
      include_kinds: ["component_instance"],
    });
    const codes = (res.warnings ?? []).map((w) => w.code);
    expect(codes).toContain("subfile_kind_ignored");
    expect(
      res.snapshot.nodes.some((n) => n.kind === "component_instance"),
    ).toBe(false);
  });

  it("drops orphan nodes when include_orphans=false", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/Scripts/Player.cs"),
      prefabWithComponent(
        GUID.prefabPlayer,
        "Assets/Prefabs/Player.prefab",
        GUID.scriptPlayer,
      ),
      // Unreferenced ScriptableObject with no script binding → degree 0.
      {
        rel: "Assets/Misc/Orphan.asset",
        content: `%YAML 1.1\n--- !u!29 &1\nFoo:\n  bar: baz\n`,
        guid: GUID.orphanSo,
      },
    ]);

    const res = await buildAssetGraph(root, index, {
      ...emptyRequest,
      include_orphans: false,
    });
    const ids = new Set(res.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`unity://asset/${GUID.orphanSo}`)).toBe(false);
    expect(ids.has(`unity://prefab/${GUID.prefabPlayer}`)).toBe(true);
  });

  it("path_globs filters nodes and drops boundary-crossing edges", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/InScope/Player.cs"),
      prefabWithComponent(
        GUID.inScopePrefab,
        "Assets/InScope/Player.prefab",
        GUID.scriptPlayer,
      ),
      // Out-of-scope script + prefab — script_used_by_prefab edge
      // crosses the boundary and must be dropped.
      script(GUID.scriptEnemy, "Assets/OutOfScope/Enemy.cs"),
      prefabWithComponent(
        GUID.outOfScopePrefab,
        "Assets/OutOfScope/Enemy.prefab",
        GUID.scriptEnemy,
      ),
    ]);

    const res = await buildAssetGraph(root, index, {
      ...emptyRequest,
      path_globs: ["Assets/InScope/**"],
    });
    const ids = new Set(res.snapshot.nodes.map((n) => n.id));
    expect(ids.has("unity://script/Assets/InScope/Player.cs")).toBe(true);
    expect(ids.has(`unity://prefab/${GUID.inScopePrefab}`)).toBe(true);
    expect(ids.has("unity://script/Assets/OutOfScope/Enemy.cs")).toBe(false);
    expect(ids.has(`unity://prefab/${GUID.outOfScopePrefab}`)).toBe(false);
    // No edge in the result may reference an out-of-scope node, except
    // script_declares_class (which deliberately dangles toward Day-8 csharp).
    for (const e of res.snapshot.edges) {
      expect(ids.has(e.source)).toBe(true);
      if (e.kind !== "script_declares_class") {
        expect(ids.has(e.target)).toBe(true);
      }
    }
  });

  it("counts sub-file kinds into stats.skipped_component_instances and ..._fields", async () => {
    const { root, index } = setup([
      script(GUID.scriptPlayer, "Assets/Scripts/Owner.cs"),
      plainPrefab(GUID.bulletPrefab, "Assets/Prefabs/Bullet.prefab"),
      prefabWithBindings(
        GUID.prefabPlayer,
        "Assets/Prefabs/Owner.prefab",
        GUID.scriptPlayer,
        GUID.bulletPrefab,
        2,
      ),
    ]);
    const res = await buildAssetGraph(root, index, emptyRequest);
    expect(res.snapshot.stats.skipped_component_instances).toBeGreaterThan(0);
    expect(res.snapshot.stats.skipped_component_fields).toBe(2);
  });
});
