/**
 * index.ts: the tool contract shared by every host, plus small helpers for defining
 * tools and validating their arguments.
 *
 * Tools are host-agnostic: the MCP server lists them for Claude Code; a Pi extension
 * can register the same definitions. Parameters are plain JSON Schema.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Text, or an image as base64 (MCP's image content), which only inspect_media returns. */
export type ToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, any>): Promise<ToolResult>;
}

export function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

export function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    details: { error: true, ...details },
  };
}

export function isFailure(result: ToolResult): boolean {
  return result.details["error"] === true;
}

/** Thrown by argument validators; the dispatcher turns it into a tool error. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

// ── Schema helpers ────────────────────────────────────────────────────────────

export const schema = {
  str(description: string): Record<string, unknown> {
    return { type: "string", description };
  },
  int(description: string, minimum?: number, maximum?: number): Record<string, unknown> {
    const out: Record<string, unknown> = { type: "integer", description };
    if (minimum !== undefined) out["minimum"] = minimum;
    if (maximum !== undefined) out["maximum"] = maximum;
    return out;
  },
  bool(description: string): Record<string, unknown> {
    return { type: "boolean", description };
  },
  oneOf(values: readonly string[], description: string): Record<string, unknown> {
    return { type: "string", enum: [...values], description };
  },
  list(items: Record<string, unknown>, description: string): Record<string, unknown> {
    return { type: "array", items, description };
  },
  obj(
    properties: Record<string, Record<string, unknown>>,
    optional: string[] = [],
  ): Record<string, unknown> {
    return {
      type: "object",
      properties,
      required: Object.keys(properties).filter((key) => !optional.includes(key)),
    };
  },
};

// ── Argument readers ──────────────────────────────────────────────────────────

export function requireString(
  args: Record<string, unknown>,
  key: string,
  maxLength = 100_000,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(`${key} must be a non-empty string`);
  }
  if (value.length > maxLength)
    throw new ToolArgumentError(`${key} exceeds ${maxLength} characters`);
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength = 100_000,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolArgumentError(`${key} must be a string`);
  if (value.length > maxLength)
    throw new ToolArgumentError(`${key} exceeds ${maxLength} characters`);
  return value;
}

export function optionalInt(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolArgumentError(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function requireInt(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = optionalInt(args, key, minimum, maximum);
  if (value === undefined) throw new ToolArgumentError(`${key} is required`);
  return value;
}

export function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolArgumentError(`${key} must be true or false`);
  return value;
}

export function requireBool(args: Record<string, unknown>, key: string): boolean {
  const value = optionalBool(args, key);
  if (value === undefined) throw new ToolArgumentError(`${key} is required`);
  return value;
}

export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ToolArgumentError(`${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

export function stringList(args: Record<string, unknown>, key: string, maxItems = 20): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ToolArgumentError(`${key} must be a list of strings`);
  }
  if (value.length > maxItems)
    throw new ToolArgumentError(`${key} has more than ${maxItems} items`);
  return (value as string[]).map((v) => v.trim()).filter(Boolean);
}
