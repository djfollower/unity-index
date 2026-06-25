import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the `rg` binary at startup. Checks PATH first (covers brew install,
 * scoop, etc.), then falls back to the copy VS Code ships with its built-in
 * search. Returns null when no rg is found, in which case callers should fall
 * back to a pure-Node implementation.
 */
let cached: string | null | undefined;

export function findRipgrep(): string | null {
  if (cached !== undefined) return cached;
  cached = resolveRipgrep();
  return cached;
}

function resolveRipgrep(): string | null {
  const exeName = process.platform === "win32" ? "rg.exe" : "rg";
  return searchPath(exeName);
}

function searchPath(exe: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RipgrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface RipgrepOptions {
  rgPath: string;
  cwd: string;
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  filePattern?: string;
  limit: number;
  signal?: AbortSignal;
}

const SKIP_DIRS = ["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"];

export async function runRipgrep(opts: RipgrepOptions): Promise<RipgrepMatch[]> {
  const args: string[] = ["--json", "--no-config"];
  if (!opts.isRegex) args.push("-F");
  if (!opts.caseSensitive) args.push("-i");
  if (opts.filePattern && opts.filePattern.length > 0) {
    for (const token of opts.filePattern.split(",")) {
      const trimmed = token.trim();
      if (trimmed.length > 0) args.push("-g", trimmed);
    }
  }
  for (const d of SKIP_DIRS) args.push("-g", `!${d}`);
  args.push("--", opts.pattern);

  return new Promise<RipgrepMatch[]>((resolve, reject) => {
    const proc = spawn(opts.rgPath, args, { cwd: opts.cwd });
    const matches: RipgrepMatch[] = [];
    let buffer = "";
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    };

    if (opts.signal) {
      if (opts.signal.aborted) stop();
      else opts.signal.addEventListener("abort", stop, { once: true });
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let evt: RgEvent;
        try {
          evt = JSON.parse(line) as RgEvent;
        } catch {
          continue;
        }
        if (evt.type !== "match") continue;
        const m = evt.data;
        const file = m.path?.text ?? "";
        const lineNo = m.line_number ?? 0;
        const text = m.lines?.text ?? "";
        const col =
          (m.submatches && m.submatches[0]?.start !== undefined
            ? m.submatches[0].start + 1
            : 1);
        matches.push({ file, line: lineNo, column: col, text: text.replace(/\r?\n$/, "") });
        if (matches.length >= opts.limit) {
          stop();
          break;
        }
      }
    });

    proc.stderr.on("data", () => { /* swallow — non-fatal */ });
    proc.on("error", (e) => {
      if (stopped) resolve(matches);
      else reject(e);
    });
    proc.on("close", () => resolve(matches));
  });
}

interface RgEvent {
  type: string;
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number; end?: number; match?: { text?: string } }>;
  };
}
