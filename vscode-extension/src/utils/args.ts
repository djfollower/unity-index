export type Args = Record<string, unknown>;

export function optionalString(args: Args, name: string): string | undefined {
  const raw = args[name];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalInt(args: Args, name: string): number | undefined {
  const raw = args[name];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function optionalBoolean(args: Args, name: string): boolean | undefined {
  const raw = args[name];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return undefined;
}

export function requireString(args: Args, name: string): string {
  const v = optionalString(args, name);
  if (v === undefined) {
    throw new Error(`Missing required parameter: ${name}`);
  }
  return v;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
