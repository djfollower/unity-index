// Day 8.6 — wire-validation tests for the VS Code code-edges tool. The
// harvest itself talks to vscode.commands which isn't reachable in vitest;
// we cover the parts that don't need the LSP runtime (validation rules and
// the throw-on-bad-input behavior the bridge handler relies on) and lean
// on the cross-impl parity with the Kotlin runDirect for the rest.

import { describe, expect, it, vi } from "vitest";

// Vitest doesn't ship a vscode shim. The harvester pulls vscode for the
// LSP-bridge wrappers, but the validation paths exercised here throw
// before any vscode call, so a minimal mock is enough.
vi.mock("vscode", () => ({
  SymbolKind: { Class: 4, Method: 5, Struct: 22, Interface: 10, Enum: 9, Function: 11, Constructor: 8 },
  Position: class { constructor(public line: number, public character: number) {} },
  Location: class { constructor(public uri: unknown, public range: unknown) {} },
  Range: class { constructor(public start: unknown, public end: unknown) {} },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file", path: p }) },
}));

import type { CodeEdgesRequest } from "@unity-index/graph-core";
import { harvestCodeEdges } from "../unityGraphCodeEdgesTool";

const baseReq = (overrides: Partial<CodeEdgesRequest>): CodeEdgesRequest => ({
  project_path: "/tmp/proj",
  symbol_ids: [],
  ...overrides,
});

describe("harvestCodeEdges validation", () => {
  it("throws invalid_id when symbol_ids is empty", async () => {
    await expect(
      harvestCodeEdges("/tmp/proj", baseReq({ symbol_ids: [] })),
    ).rejects.toThrow(/^invalid_id:/);
  });

  it("throws invalid_id when symbol_ids exceeds the documented cap", async () => {
    const ids = Array.from(
      { length: 501 },
      (_, i) => `unity://csharp/T:Foo.Bar${i}`,
    );
    await expect(
      harvestCodeEdges("/tmp/proj", baseReq({ symbol_ids: ids })),
    ).rejects.toThrow(/^invalid_id:.*501/);
  });

  it("throws invalid_id when any entry is missing the unity csharp prefix", async () => {
    await expect(
      harvestCodeEdges(
        "/tmp/proj",
        baseReq({ symbol_ids: ["T:Foo.Bar"] }),
      ),
    ).rejects.toThrow(/^invalid_id:/);
  });

  it("throws invalid_id for non-string entries", async () => {
    await expect(
      harvestCodeEdges(
        "/tmp/proj",
        baseReq({ symbol_ids: [42 as unknown as string] }),
      ),
    ).rejects.toThrow(/^invalid_id:/);
  });
});
