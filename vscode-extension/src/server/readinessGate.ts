import * as vscode from "vscode";

/**
 * Tracks whether the C# Dev Kit / Roslyn LSP is ready to answer language queries.
 *
 * VS Code does not expose a public "project loaded" event, so we approximate by:
 *  - checking that the `csharp` extension is active, and
 *  - probing a workspace symbol query against a known stable identifier ("MonoBehaviour")
 *    to confirm the language server returns non-empty results.
 *
 * Tools that need LSP can `await gate.waitUntilReady(timeoutMs)` to block until ready,
 * with the GetIndexStatusTool surfacing the current state to clients.
 */
export class ReadinessGate {
  private ready = false;
  private waiters: Array<(value: boolean) => void> = [];
  private probeTimer?: NodeJS.Timeout;

  start(intervalMs = 2000): void {
    const probe = async () => {
      if (this.ready) return;
      if (await this.probe()) {
        this.ready = true;
        for (const w of this.waiters.splice(0)) w(true);
        if (this.probeTimer) {
          clearInterval(this.probeTimer);
          this.probeTimer = undefined;
        }
      }
    };
    void probe();
    this.probeTimer = setInterval(probe, intervalMs);
  }

  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
    for (const w of this.waiters.splice(0)) w(false);
  }

  isReady(): boolean {
    return this.ready;
  }

  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return true;
    if (timeoutMs <= 0) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(notify);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const notify = (v: boolean) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push(notify);
    });
  }

  private async probe(): Promise<boolean> {
    const csharp =
      vscode.extensions.getExtension("ms-dotnettools.csharp") ??
      vscode.extensions.getExtension("ms-dotnettools.csdevkit");
    if (!csharp) return false;
    if (!csharp.isActive) return false;

    try {
      const symbols = (await vscode.commands.executeCommand(
        "vscode.executeWorkspaceSymbolProvider",
        "MonoBehaviour",
      )) as vscode.SymbolInformation[] | undefined;
      return Array.isArray(symbols) && symbols.length > 0;
    } catch {
      return false;
    }
  }
}
