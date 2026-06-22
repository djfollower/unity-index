import { ToolDefinition } from "../models/jsonRpc";
import { McpTool } from "./abstractTool";

export class ToolRegistry {
  private readonly tools = new Map<string, McpTool>();

  register(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): McpTool | undefined {
    return this.tools.get(name);
  }

  getAll(): McpTool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
