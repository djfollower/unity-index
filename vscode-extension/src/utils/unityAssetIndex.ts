import * as fs from "fs";
import * as path from "path";
import { ProjectContext, toRelativePath } from "../server/projectResolver";
import { parseUnityYaml, UnityYamlDocument } from "./unityYaml";

const ASSET_EXTENSIONS = new Set([".prefab", ".unity", ".asset"]);
const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"]);
const GUID_REGEX = /^guid:\s*([0-9a-fA-F]{32})\s*$/m;

export interface ComponentUsage {
  assetFile: string;
  gameObjectName: string | null;
  gameObjectFileId: number | null;
  fileId: number;
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
  fileId: number;
}

export interface SerializedFieldResult {
  typeName: string;
  fieldName: string;
  scriptGuid: string | null;
  values: SerializedFieldValue[];
  totalCount: number;
}

export class UnityAssetIndex {
  private guidToPath: Map<string, string> = new Map();
  private pathToGuid: Map<string, string> = new Map();

  constructor(private readonly project: ProjectContext) {
    this.scanMetaFiles(project.rootPath);
  }

  findComponentUsages(typeName: string): ComponentUsageResult {
    const scriptGuid = this.findScriptGuid(typeName);
    if (!scriptGuid) {
      return { typeName, scriptGuid: null, usages: [], totalCount: 0 };
    }

    const usages: ComponentUsage[] = [];
    this.forEachAssetFile((file) => {
      const docs = this.parseAsset(file);
      const gameObjects = new Map<number, UnityYamlDocument>();
      for (const d of docs) if (d.classId === 1) gameObjects.set(d.fileId, d);

      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        if (doc.getScriptGuid() !== scriptGuid) continue;
        const goFileId = doc.getGameObjectFileId();
        const goName = goFileId !== null ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null : null;
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

  findEventBindings(methodName: string): EventBindingResult {
    const bindings: EventBinding[] = [];
    this.forEachAssetFile((file) => {
      const docs = this.parseAsset(file);
      const gameObjects = new Map<number, UnityYamlDocument>();
      for (const d of docs) if (d.classId === 1) gameObjects.set(d.fileId, d);

      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        for (const call of doc.getPersistentCalls()) {
          if (call.methodName !== methodName) continue;
          const goFileId = doc.getGameObjectFileId();
          const goName = goFileId !== null ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null : null;
          bindings.push({
            assetFile: toRelativePath(this.project, file),
            eventFieldPath: findEventFieldName(doc, methodName) ?? "unknown",
            targetTypeName: call.targetAssemblyTypeName?.split(",")[0].trim() ?? null,
            methodName: call.methodName,
            gameObjectName: goName,
            callState: call.callState,
          });
        }
      }
    });
    return { methodName, bindings, totalCount: bindings.length };
  }

  findSerializedFieldValues(
    typeName: string,
    fieldName: string,
  ): SerializedFieldResult {
    const scriptGuid = this.findScriptGuid(typeName);
    if (!scriptGuid) {
      return { typeName, fieldName, scriptGuid: null, values: [], totalCount: 0 };
    }

    const values: SerializedFieldValue[] = [];
    this.forEachAssetFile((file) => {
      const docs = this.parseAsset(file);
      const gameObjects = new Map<number, UnityYamlDocument>();
      for (const d of docs) if (d.classId === 1) gameObjects.set(d.fileId, d);

      for (const doc of docs) {
        if (doc.classId !== 114) continue;
        if (doc.getScriptGuid() !== scriptGuid) continue;
        const v = doc.getSerializedFieldValue(fieldName);
        if (v === undefined) continue;
        const goFileId = doc.getGameObjectFileId();
        const goName = goFileId !== null ? gameObjects.get(goFileId)?.getProperty("m_Name") ?? null : null;
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

  private parseAsset(filePath: string): UnityYamlDocument[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return parseUnityYaml(content, filePath);
    } catch {
      return [];
    }
  }

  private forEachAssetFile(action: (absolutePath: string) => void): void {
    walk(this.project.rootPath, (entry, isDir) => {
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));
      if (ASSET_EXTENSIONS.has(path.extname(entry))) {
        try {
          action(entry);
        } catch {
          /* keep scanning */
        }
      }
      return true;
    });
  }

  private scanMetaFiles(root: string): void {
    walk(root, (entry, isDir) => {
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));
      if (!entry.endsWith(".meta")) return true;
      try {
        const fd = fs.openSync(entry, "r");
        const buf = Buffer.alloc(512);
        const n = fs.readSync(fd, buf, 0, 512, 0);
        fs.closeSync(fd);
        const header = buf.toString("utf-8", 0, n);
        const m = GUID_REGEX.exec(header);
        if (!m) return true;
        const assetPath = entry.slice(0, -5);
        this.guidToPath.set(m[1], assetPath);
        this.pathToGuid.set(assetPath, m[1]);
      } catch {
        /* ignore */
      }
      return true;
    });
  }
}

function walk(
  root: string,
  visit: (path: string, isDir: boolean) => boolean,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (visit(full, true)) walk(full, visit);
    } else {
      visit(full, false);
    }
  }
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
