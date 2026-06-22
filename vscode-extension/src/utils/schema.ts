import { PARAM_NAMES } from "../constants";

type JsonSchema = Record<string, unknown>;

export class SchemaBuilder {
  private properties: Record<string, JsonSchema> = {};
  private required: string[] = [];

  static tool(): SchemaBuilder {
    return new SchemaBuilder();
  }

  projectPath(): this {
    this.properties[PARAM_NAMES.PROJECT_PATH] = {
      type: "string",
      description:
        "Absolute path to the project root. Optional unless multiple workspace folders are open.",
    };
    return this;
  }

  file(required = true, description?: string): this {
    this.properties[PARAM_NAMES.FILE] = {
      type: "string",
      description:
        description ?? "Project-relative file path, or an absolute path.",
    };
    if (required) this.required.push(PARAM_NAMES.FILE);
    return this;
  }

  lineAndColumn(required = true): this {
    this.properties[PARAM_NAMES.LINE] = {
      type: "integer",
      description: "1-based line number.",
    };
    this.properties[PARAM_NAMES.COLUMN] = {
      type: "integer",
      description: "1-based column number.",
    };
    if (required) {
      this.required.push(PARAM_NAMES.LINE);
      this.required.push(PARAM_NAMES.COLUMN);
    }
    return this;
  }

  stringProperty(name: string, description: string, required = false): this {
    this.properties[name] = { type: "string", description };
    if (required) this.required.push(name);
    return this;
  }

  intProperty(name: string, description: string, required = false): this {
    this.properties[name] = { type: "integer", description };
    if (required) this.required.push(name);
    return this;
  }

  booleanProperty(name: string, description: string, required = false): this {
    this.properties[name] = { type: "boolean", description };
    if (required) this.required.push(name);
    return this;
  }

  enumProperty(
    name: string,
    description: string,
    values: string[],
    required = false,
  ): this {
    this.properties[name] = { type: "string", description, enum: values };
    if (required) this.required.push(name);
    return this;
  }

  build(): JsonSchema {
    const schema: JsonSchema = {
      type: "object",
      properties: this.properties,
    };
    if (this.required.length > 0) {
      schema.required = this.required;
    }
    return schema;
  }
}
