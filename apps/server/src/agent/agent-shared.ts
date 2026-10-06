/**
 * Micro-helpers shared by the agent domains. Deliberately free of domain
 * knowledge and of imports, so every extracted module can use them without
 * creating cycles.
 */

import { createHash } from "node:crypto";
export class AgentServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}


/** Content-addressed id prefix: stable across runs and machines. */
export function sha256Digest(value: string): string {
  return `sha256.${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function uniqueStrings(values: readonly string[], maximum: number, name: string): string[] {
  if (values.length > maximum) throw new AgentServiceError("INVALID_ARGUMENT", `${name} 数量超过限制。`);
  const result = [...new Set(values.map((value) => value.trim()))];
  if (result.some((value) => !value || value.length > 128)) {
    throw new AgentServiceError("INVALID_ARGUMENT", `${name} 包含无效标识。`);
  }
  return result;
}

export function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AgentServiceError("INVALID_ARGUMENT", `${name} 无效。`);
  }
  return normalized;
}

export function clipped(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}
