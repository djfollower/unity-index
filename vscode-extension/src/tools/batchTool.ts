import { AbstractMcpTool, McpTool, ToolContext } from "./abstractTool";
import { ToolRegistry } from "./toolRegistry";
import { TOOL_NAMES, PARAM_NAMES } from "../constants";
import { ProjectContext, resolveProject } from "../server/projectResolver";
import { Args } from "../utils/args";
import { SchemaBuilder } from "../utils/schema";
import { ToolCallResult } from "../models/jsonRpc";

/**
 * Multi-call dispatcher mirroring the Kotlin BatchTool. Lets a client send N
 * tool invocations in a single MCP request; the server probes LSP readiness
 * once, resolves the inherited project_path once, and runs entries
 * concurrently up to a configurable cap.
 *
 * Wire format MUST stay identical to src/main/kotlin/.../tools/BatchTool.kt
 * (same name, schema, response envelope). See that file for the contract.
 */
export class BatchTool extends AbstractMcpTool {
  // Hard upper bound on entries per batch. Sized for the "sweep 256 symbols at
  // once" case; raise after we have real timing data on a 30k-file Unity
  // project. The Kotlin variant uses the same number — keep in lockstep.
  static readonly MAX_ENTRIES = 256;
  static readonly DEFAULT_CONCURRENCY = 8;
  static readonly MAX_CONCURRENCY = 16;
  static readonly DEFAULT_ENTRY_TIMEOUT_MS = 120_000;
  static readonly MAX_BATCH_TIMEOUT_MS = 300_000;
  static readonly DEFAULT_BATCH_TIMEOUT_MS = 120_000;

  // The batch dispatcher itself doesn't touch the C# LSP — we wait on
  // readiness once inside doExecute, then dispatch entries which may or may
  // not need LSP (each underlying tool decides via its own requiresLsp).
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.BATCH;

  readonly description = [
    "Run multiple MCP tool calls in a single request. Use for any sweep that would",
    "otherwise issue N per-call requests — e.g. resolving N symbols, reading N files,",
    `or finding usages for N positions. The server runs entries concurrently (up to`,
    `${BatchTool.DEFAULT_CONCURRENCY} by default) and probes LSP readiness once for the whole batch.`,
    "",
    `Hard limits: up to ${BatchTool.MAX_ENTRIES} entries per call; concurrency capped at ${BatchTool.MAX_CONCURRENCY};`,
    `whole-batch wall clock capped at ${BatchTool.MAX_BATCH_TIMEOUT_MS}ms.`,
    "",
    "Parameters:",
    "- calls (required): array of {id, tool, arguments}. `id` is a client-chosen",
    "  string echoed in the response; must be unique within the batch. `tool` is any",
    "  registered MCP tool name except `ide_batch` (no nesting). `arguments` is the",
    "  object that tool's schema expects.",
    "- project_path (optional): merged into each call's `arguments` if the entry",
    "  does not already set it. Saves repeating the workspace path on every entry.",
    "- stopOnError (optional, default false): if true, abort on the first entry",
    "  that returns status=\"error\"; remaining entries return status=\"skipped\".",
    `- maxConcurrency (optional, default ${BatchTool.DEFAULT_CONCURRENCY}, max ${BatchTool.MAX_CONCURRENCY}).`,
    `- timeoutMs (optional, default ${BatchTool.DEFAULT_BATCH_TIMEOUT_MS}, max ${BatchTool.MAX_BATCH_TIMEOUT_MS}):`,
    "  whole-batch wall clock budget.",
    "",
    "Response envelope:",
    "{",
    '  "results": [',
    '    { "id": "...", "status": "ok",      "result": <ToolCallResult> },',
    '    { "id": "...", "status": "error",   "error": "<dispatch failure>" },',
    '    { "id": "...", "status": "skipped", "reason": "stopOnError" | "batchTimeout" }',
    "  ],",
    '  "syncMs": <int>,',
    '  "totalMs": <int>,',
    '  "concurrency": <int>',
    "}",
    "",
    "`status=\"ok\"` includes tool-level errors (`result.isError=true`); `status=\"error\"`",
    "is reserved for dispatch failures (unknown tool, malformed entry, nested batch).",
  ].join("\n");

  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(
      "stopOnError",
      "If true, abort on the first entry that returns status=\"error\"; remaining entries return status=\"skipped\". Default false.",
    )
    .intProperty(
      "maxConcurrency",
      `Max parallel entries, default ${BatchTool.DEFAULT_CONCURRENCY}, max ${BatchTool.MAX_CONCURRENCY}.`,
    )
    .intProperty(
      "timeoutMs",
      `Whole-batch wall clock budget in ms, default ${BatchTool.DEFAULT_BATCH_TIMEOUT_MS}, max ${BatchTool.MAX_BATCH_TIMEOUT_MS}.`,
    )
    .build();

  // `calls` is added manually because SchemaBuilder doesn't model array schemas.
  // SchemaBuilder.build() returned a fresh object above; mutate to inject.
  constructor(private readonly registry: ToolRegistry) {
    super();
    const schema = this.inputSchema as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    props.calls = {
      type: "array",
      description: `Tool calls to execute (1..${BatchTool.MAX_ENTRIES}).`,
      minItems: 1,
      maxItems: BatchTool.MAX_ENTRIES,
      items: {
        type: "object",
        required: ["id", "tool", "arguments"],
        properties: {
          id: {
            type: "string",
            description: "Client-chosen key, unique within the batch.",
          },
          tool: {
            type: "string",
            description: "Registered tool name. `ide_batch` is rejected.",
          },
          arguments: {
            type: "object",
            description: "Arguments object for that tool's schema.",
          },
        },
      },
    };
    schema.properties = props;
    const required = (schema.required as string[] | undefined) ?? [];
    if (!required.includes("calls")) required.push("calls");
    schema.required = required;
    // stopOnError should be a boolean per the spec, but SchemaBuilder only
    // exposes booleanProperty; swap the type post-build for accuracy.
    (props["stopOnError"] as Record<string, unknown>).type = "boolean";
  }

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const batchStart = Date.now();

    const callsRaw = args["calls"];
    if (!Array.isArray(callsRaw)) {
      return this.error("`calls` must be a JSON array");
    }
    if (callsRaw.length === 0) {
      return this.error("`calls` must contain at least one entry");
    }
    if (callsRaw.length > BatchTool.MAX_ENTRIES) {
      return this.error(
        `\`calls\` exceeds the per-batch limit of ${BatchTool.MAX_ENTRIES} (got ${callsRaw.length})`,
      );
    }

    const entries: Entry[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < callsRaw.length; i++) {
      const parsed = parseEntry(callsRaw[i], i, seenIds);
      if ("invalid" in parsed) return this.error(parsed.invalid);
      entries.push(parsed.entry);
    }

    const inheritedProjectPath =
      typeof args[PARAM_NAMES.PROJECT_PATH] === "string"
        ? (args[PARAM_NAMES.PROJECT_PATH] as string)
        : undefined;
    const stopOnError = args["stopOnError"] === true;
    const maxConcurrency = clamp(
      asInt(args["maxConcurrency"]) ?? BatchTool.DEFAULT_CONCURRENCY,
      1,
      BatchTool.MAX_CONCURRENCY,
    );
    const batchTimeoutMs = clamp(
      asInt(args["timeoutMs"]) ?? BatchTool.DEFAULT_BATCH_TIMEOUT_MS,
      1_000,
      BatchTool.MAX_BATCH_TIMEOUT_MS,
    );

    // Probe LSP readiness once for the whole batch. AbstractMcpTool already
    // skipped the gate for BatchTool itself (requiresLsp=false), so this is
    // the single shared wait that entries needing LSP benefit from.
    const syncStart = Date.now();
    if (!ctx.readiness.isReady()) {
      await ctx.readiness.waitUntilReady(ctx.readinessTimeoutMs);
    }
    const syncMs = Date.now() - syncStart;

    ctx.log(
      `BatchTool: ${entries.length} entries, concurrency=${maxConcurrency}, timeoutMs=${batchTimeoutMs}, stopOnError=${stopOnError}`,
    );

    const results: (EntryResult | undefined)[] = new Array(entries.length);
    let aborted = false;
    let timedOut = false;
    let inFlight = 0;
    let nextIndex = 0;

    await new Promise<void>((resolve) => {
      const watchdog = setTimeout(() => {
        timedOut = true;
        finish();
      }, batchTimeoutMs);

      const finish = () => {
        clearTimeout(watchdog);
        resolve();
      };

      const pump = () => {
        if (timedOut) return;
        while (inFlight < maxConcurrency && nextIndex < entries.length) {
          const i = nextIndex++;
          const entry = entries[i];
          if (aborted && stopOnError) {
            results[i] = { kind: "skipped", id: entry.id, reason: "stopOnError" };
            continue;
          }
          inFlight++;
          runEntry(this.registry, entry, inheritedProjectPath, project, ctx)
            .then((r) => {
              results[i] = r;
              if (stopOnError && r.kind === "error") aborted = true;
            })
            .catch((e) => {
              results[i] = {
                kind: "ok",
                id: entry.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: e instanceof Error ? e.message : String(e),
                    },
                  ],
                  isError: true,
                },
              };
            })
            .finally(() => {
              inFlight--;
              if (timedOut) return;
              if (nextIndex >= entries.length && inFlight === 0) {
                finish();
              } else {
                pump();
              }
            });
        }
      };

      pump();
    });

    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = {
          kind: "skipped",
          id: entries[i].id,
          reason: "batchTimeout",
        };
      }
    }

    const totalMs = Date.now() - batchStart;
    const envelope = {
      results: results.map((r) => serializeResult(r!)),
      syncMs,
      totalMs,
      concurrency: maxConcurrency,
    };
    void timedOut; // surfaced via skipped entries; logged below.
    if (timedOut) {
      ctx.log(`BatchTool: hit whole-batch timeout after ${batchTimeoutMs}ms`);
    }
    return this.success(JSON.stringify(envelope, null, 2));
  }
}

interface Entry {
  id: string;
  tool: string;
  arguments: Args;
}

type EntryResult =
  | { kind: "ok"; id: string; result: ToolCallResult }
  | { kind: "error"; id: string; message: string }
  | { kind: "skipped"; id: string; reason: string };

function serializeResult(r: EntryResult): Record<string, unknown> {
  switch (r.kind) {
    case "ok":
      return { id: r.id, status: "ok", result: r.result };
    case "error":
      return { id: r.id, status: "error", error: r.message };
    case "skipped":
      return { id: r.id, status: "skipped", reason: r.reason };
  }
}

function parseEntry(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
): { entry: Entry } | { invalid: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { invalid: `calls[${index}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return {
      invalid: `calls[${index}].id is required and must be a non-empty string`,
    };
  }
  if (seenIds.has(id)) {
    return {
      invalid: `calls[${index}].id duplicates an earlier entry: "${id}"`,
    };
  }
  seenIds.add(id);
  const tool = obj.tool;
  if (typeof tool !== "string") {
    return {
      invalid: `calls[${index}].tool is required and must be a string`,
    };
  }
  if (tool === TOOL_NAMES.BATCH) {
    return {
      invalid: `calls[${index}] (id="${id}"): ide_batch cannot be nested`,
    };
  }
  const argsVal = obj.arguments;
  if (!argsVal || typeof argsVal !== "object" || Array.isArray(argsVal)) {
    return {
      invalid: `calls[${index}].arguments is required and must be an object (use {} for none)`,
    };
  }
  return { entry: { id, tool, arguments: argsVal as Args } };
}

async function runEntry(
  registry: ToolRegistry,
  entry: Entry,
  inheritedProjectPath: string | undefined,
  defaultProject: ProjectContext,
  ctx: ToolContext,
): Promise<EntryResult> {
  const tool: McpTool | undefined = registry.getTool(entry.tool);
  if (!tool) {
    return { kind: "error", id: entry.id, message: `Tool not found: ${entry.tool}` };
  }

  const mergedArgs = mergeProjectPath(entry.arguments, inheritedProjectPath);
  const entryProjectPath =
    typeof mergedArgs[PARAM_NAMES.PROJECT_PATH] === "string"
      ? (mergedArgs[PARAM_NAMES.PROJECT_PATH] as string)
      : undefined;

  let project: ProjectContext;
  if (entryProjectPath) {
    const resolved = resolveProject(entryProjectPath);
    if (resolved.errorResult) {
      return { kind: "ok", id: entry.id, result: resolved.errorResult };
    }
    project = resolved.project!;
  } else {
    project = defaultProject;
  }

  try {
    const result = await withTimeout(
      tool.execute(project, mergedArgs, ctx),
      BatchTool.DEFAULT_ENTRY_TIMEOUT_MS,
      `Entry timed out after ${BatchTool.DEFAULT_ENTRY_TIMEOUT_MS}ms`,
    );
    return { kind: "ok", id: entry.id, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      kind: "ok",
      id: entry.id,
      result: { content: [{ type: "text", text: message }], isError: true },
    };
  }
}

function mergeProjectPath(args: Args, inherited: string | undefined): Args {
  if (!inherited) return args;
  if (typeof args[PARAM_NAMES.PROJECT_PATH] === "string") return args;
  return { ...args, [PARAM_NAMES.PROJECT_PATH]: inherited };
}

function asInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
