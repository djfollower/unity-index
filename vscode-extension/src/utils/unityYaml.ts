// Port of src/main/kotlin/.../util/UnityYamlParser.kt.
// Parses Unity's restricted YAML asset format (--- !u!classId &fileId headers).

export interface PersistentCall {
  targetFileId: number | null;
  targetGuid: string | null;
  targetAssemblyTypeName: string | null;
  methodName: string;
  mode: number;
  callState: number;
}

const CLASS_ID_NAMES: Record<number, string> = {
  1: "GameObject",
  4: "Transform",
  114: "MonoBehaviour",
  224: "RectTransform",
  1001: "PrefabInstance",
};

const DOCUMENT_HEADER = /^---\s+!u!(\d+)\s+&(\d+)/;
const INLINE_MAP = /\{([^}]*)\}/;
const KEY_VALUE = /^(\s*)(\S+?):\s*(.*)$/;

export class UnityYamlDocument {
  constructor(
    readonly classId: number,
    readonly fileId: number,
    readonly typeName: string,
    readonly properties: Map<string, string>,
    readonly sourceFile: string,
  ) {}

  getProperty(key: string): string | undefined {
    return this.properties.get(key);
  }

  getScriptGuid(): string | undefined {
    return this.properties.get("m_Script.guid");
  }

  getGameObjectFileId(): number | null {
    const v = this.properties.get("m_GameObject.fileID");
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  getSerializedFieldValue(fieldName: string): string | undefined {
    return this.properties.get(fieldName);
  }

  getPersistentCalls(): PersistentCall[] {
    const calls: PersistentCall[] = [];
    let i = 0;
    while (true) {
      const methodName = this.properties.get(
        `m_PersistentCalls.m_Calls[${i}].m_MethodName`,
      );
      if (methodName === undefined) break;
      calls.push({
        targetFileId: parseLong(
          this.properties.get(`m_PersistentCalls.m_Calls[${i}].m_Target.fileID`),
        ),
        targetGuid: this.properties.get(
          `m_PersistentCalls.m_Calls[${i}].m_Target.guid`,
        ) ?? null,
        targetAssemblyTypeName: this.properties.get(
          `m_PersistentCalls.m_Calls[${i}].m_TargetAssemblyTypeName`,
        ) ?? null,
        methodName,
        mode: parseInt(
          this.properties.get(`m_PersistentCalls.m_Calls[${i}].m_Mode`) ?? "0",
          10,
        ) || 0,
        callState: parseInt(
          this.properties.get(`m_PersistentCalls.m_Calls[${i}].m_CallState`) ?? "0",
          10,
        ) || 0,
      });
      i++;
    }
    return calls;
  }
}

function parseLong(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseUnityYaml(
  content: string,
  sourcePath: string,
): UnityYamlDocument[] {
  const documents: UnityYamlDocument[] = [];
  const lines = content.split(/\r?\n/);

  let classId = -1;
  let fileId = -1;
  let currentLines: string[] = [];
  let inDocument = false;

  for (const line of lines) {
    const hm = DOCUMENT_HEADER.exec(line);
    if (hm) {
      if (inDocument) {
        const doc = parseDocument(classId, fileId, currentLines, sourcePath);
        if (doc) documents.push(doc);
      }
      classId = parseInt(hm[1], 10);
      fileId = parseInt(hm[2], 10);
      currentLines = [];
      inDocument = true;
      continue;
    }
    if (inDocument) currentLines.push(line);
  }

  if (inDocument) {
    const doc = parseDocument(classId, fileId, currentLines, sourcePath);
    if (doc) documents.push(doc);
  }

  return documents;
}

function parseDocument(
  classId: number,
  fileId: number,
  lines: string[],
  sourcePath: string,
): UnityYamlDocument | null {
  if (lines.length === 0) return null;

  const typeName =
    lines[0]?.trim().replace(/:$/, "") ||
    CLASS_ID_NAMES[classId] ||
    "Unknown";

  const properties = new Map<string, string>();
  const pathStack: Array<[string, number]> = [];
  let arrayIndex = -1;

  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    const m = KEY_VALUE.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const rawValue = m[3].trim();

    while (pathStack.length > 0 && pathStack[pathStack.length - 1][1] >= indent) {
      pathStack.pop();
    }

    if (key === "-") {
      arrayIndex++;
      if (rawValue.length > 0) {
        const flatKey = buildFlatKey(pathStack, `[${arrayIndex}]`);
        const inlineMap = parseInlineMap(rawValue);
        if (inlineMap) {
          for (const [mk, mv] of Object.entries(inlineMap)) {
            properties.set(`${flatKey}.${mk}`, mv);
          }
        } else {
          properties.set(flatKey, rawValue);
        }
      }
      continue;
    }

    if (key.startsWith("- ")) {
      const actualKey = key.slice(2);
      arrayIndex++;
      const flatKey = buildFlatKey(pathStack, `[${arrayIndex}].${actualKey}`);
      properties.set(flatKey, rawValue);
      continue;
    }

    if (rawValue.length === 0) {
      pathStack.push([key, indent]);
      if (pathStack.length >= 2) {
        const parentKey = pathStack[pathStack.length - 2]?.[0] ?? "";
        if (parentKey === "m_Calls") arrayIndex = -1;
      }
      continue;
    }

    const flatKey = buildFlatKey(pathStack, key);
    const inlineMap = parseInlineMap(rawValue);
    if (inlineMap) {
      for (const [mk, mv] of Object.entries(inlineMap)) {
        properties.set(`${flatKey}.${mk}`, mv);
      }
    } else {
      properties.set(flatKey, rawValue);
    }
  }

  return new UnityYamlDocument(classId, fileId, typeName, properties, sourcePath);
}

function buildFlatKey(pathStack: Array<[string, number]>, suffix: string): string {
  if (pathStack.length === 0) return suffix;
  return pathStack.map(([k]) => k).join(".") + "." + suffix;
}

function parseInlineMap(value: string): Record<string, string> | null {
  const m = INLINE_MAP.exec(value);
  if (!m) return null;
  const inner = m[1].trim();
  if (inner.length === 0) return {};
  const result: Record<string, string> = {};
  for (const pair of inner.split(",")) {
    const idx = pair.indexOf(":");
    if (idx >= 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k.length > 0) result[k] = v;
    }
  }
  return result;
}
