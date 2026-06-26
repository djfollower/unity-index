// Result types mirroring src/main/kotlin/.../tools/models/ToolModels.kt.

export interface UsageLocation {
  file: string;
  line: number;
  column: number;
  context: string;
  type: string;
  astPath: string[];
}

export interface FindUsagesResult {
  usages: UsageLocation[];
  totalCount: number;
  truncated?: boolean;
  /** Optional caller-side guidance — present when the result shape suggests a follow-up (e.g. event-handler pattern). */
  hint?: string;
}

export interface DefinitionResult {
  file: string;
  line: number;
  column: number;
  preview: string;
  symbolName: string;
  astPath: string[];
}

export interface ReadFileResult {
  file: string;
  content: string;
  language: string | null;
  lineCount: number;
  startLine: number | null;
  endLine: number | null;
  isLibraryFile: boolean;
}

export interface TypeElement {
  name: string;
  file: string | null;
  kind: string;
  language?: string;
  supertypes?: TypeElement[];
}

export interface TypeHierarchyResult {
  element: TypeElement;
  supertypes: TypeElement[];
  subtypes: TypeElement[];
}

export interface CallElement {
  name: string;
  file: string;
  line: number;
  column: number;
  language?: string;
  children?: CallElement[];
}

export interface CallHierarchyResult {
  element: CallElement;
  calls: CallElement[];
}

export interface ImplementationLocation {
  name: string;
  file: string;
  line: number;
  column: number;
  kind: string;
  language?: string;
}

export interface ImplementationResult {
  implementations: ImplementationLocation[];
  totalCount: number;
}

export interface ProblemInfo {
  message: string;
  severity: string;
  file: string;
  line: number;
  column: number;
  endLine: number | null;
  endColumn: number | null;
}

export interface DiagnosticsResult {
  problems?: ProblemInfo[];
  problemCount?: number;
  analysisFresh?: boolean;
  analysisMessage?: string;
  buildErrors?: BuildMessage[];
  buildErrorCount?: number;
  buildWarningCount?: number;
}

export interface IndexStatusResult {
  isDumbMode: boolean;
  isIndexing: boolean;
  indexingProgress: number | null;
  unityAssets?: UnityAssetIndexStatus;
}

export interface UnityAssetIndexStatus {
  state: "idle" | "building" | "ready";
  assetCount: number | null;
  metaCount: number | null;
  buildMs: number | null;
  lastInvalidatedAt: number | null;
}

export interface SyncFilesResult {
  syncedPaths: string[];
  syncedAll: boolean;
  message: string;
}

export interface BuildMessage {
  category: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface BuildProjectResult {
  success: boolean;
  aborted?: boolean;
  errors?: number;
  warnings?: number;
  buildMessages: BuildMessage[];
  truncated?: boolean;
  rawOutput?: string;
  durationMs: number;
}

export interface SymbolMatch {
  name: string;
  qualifiedName: string | null;
  kind: string;
  file: string;
  line: number;
  column: number;
  containerName: string | null;
  language?: string;
}

export interface FindSymbolResult {
  symbols: SymbolMatch[];
  totalCount: number;
  query: string;
  /** Optional caller-side guidance — e.g. when the query looks like a Unity asset filename. */
  hint?: string;
}

export interface FindClassResult {
  classes: SymbolMatch[];
  totalCount: number;
  query: string;
  /** Optional caller-side guidance — e.g. when the query looks like a Unity asset filename. */
  hint?: string;
}

export interface FileMatch {
  name: string;
  path: string;
  directory: string;
}

export interface FindFileResult {
  files: FileMatch[];
  totalCount: number;
  query: string;
}

export interface MethodInfo {
  name: string;
  signature: string;
  containingClass: string;
  file: string;
  line: number;
  column: number;
  language?: string;
}

export interface SuperMethodInfo {
  name: string;
  signature: string;
  containingClass: string;
  containingClassKind: string;
  file: string | null;
  line: number | null;
  column: number | null;
  isInterface: boolean;
  depth: number;
  language?: string;
}

export interface SuperMethodsResult {
  method: MethodInfo;
  hierarchy: SuperMethodInfo[];
  totalCount: number;
}

export interface TextMatch {
  file: string;
  line: number;
  column: number;
  context: string;
  contextType: string;
}

export interface SearchTextResult {
  matches: TextMatch[];
  totalCount: number;
  query: string;
  hint?: string;
}

export interface SymbolBodyResult {
  file: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface FileStructureItem {
  name: string;
  kind: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  detail?: string;
  children?: FileStructureItem[];
}

export interface FileStructureResult {
  file: string;
  language: string | null;
  items: FileStructureItem[];
}
