import { z } from "zod";
import { createAgentError } from "@nami/agent-contracts";
import type { AgentTool } from "@nami/agent-core";
import type { EncryptedAgentMemoryStore } from "./memory.js";
import { autoReplyDecisionReasons, type EncryptedAutoReplyDecisionStore } from "./auto-reply-decisions.js";

/**
 * Long-term memory tools exposed to the Agent conversation. Memory records are
 * device-local and encrypted; saves/deletes are reversible, so no confirmation
 * popup is required (write tools still need send-confirmed access).
 */

const memoryRecordOutputSchema = z.object({
  id: z.string(),
  kind: z.string(),
  summary: z.string(),
  detail: z.string(),
  createdAt: z.string(),
}).strict();

const memoryListInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

const memoryListOutputSchema = z.object({
  items: z.array(memoryRecordOutputSchema),
}).strict();

const memorySaveInputSchema = z.object({
  note: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(2_000).optional(),
}).strict();

const memorySaveOutputSchema = z.object({
  saved: memoryRecordOutputSchema,
}).strict();

const memoryUpdateInputSchema = z.object({
  id: z.string().min(1).max(128),
  summary: z.string().trim().min(1).max(500).optional(),
  detail: z.string().trim().max(2_000).optional(),
}).strict();

const memoryUpdateOutputSchema = z.object({
  updated: memoryRecordOutputSchema,
}).strict();

const memoryDeleteInputSchema = z.object({
  id: z.string().min(1).max(128),
}).strict();

const memoryDeleteOutputSchema = z.object({
  deleted: z.boolean(),
}).strict();

type MemoryListInput = z.infer<typeof memoryListInputSchema>;
type MemorySaveInput = z.infer<typeof memorySaveInputSchema>;
type MemoryUpdateInput = z.infer<typeof memoryUpdateInputSchema>;
type MemoryDeleteInput = z.infer<typeof memoryDeleteInputSchema>;

function memoryFailure(error: unknown) {
  return createAgentError({
    code: "INTERNAL",
    message: "Long-term memory is not available.",
    ...(error instanceof Error ? { suggestion: error.message.slice(0, 200) } : {}),
  });
}

function recordOutput(store: EncryptedAgentMemoryStore, recordId: string) {
  const record = store.get(recordId);
  return {
    id: record.id,
    kind: record.kind,
    summary: record.summary,
    detail: record.detail ?? "",
    createdAt: record.createdAt,
  };
}

export function createMemoryTools(store: EncryptedAgentMemoryStore): AgentTool[] {
  return [
    {
      descriptor: {
        name: "memory.list",
        title: "List long-term memory",
        description: "Lists stored long-term memory notes about the user (preferences, facts, decisions). Input: { query?: string, limit?: number }. Use when the user references something from an earlier conversation or asks what you remember.",
        category: "system",
        executionMode: "read",
        requiredScopes: ["manage:memory"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: memoryListInputSchema,
      outputSchema: memoryListOutputSchema,
      execute: async (context, input: MemoryListInput) => {
        if (context.signal?.aborted) return { ok: false, error: memoryFailure(undefined) };
        try {
          const records = store.list({
            ...(input.query ? { query: input.query } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          return {
            ok: true,
            value: {
              items: records.map((record) => ({
                id: record.id,
                kind: record.kind,
                summary: record.summary,
                detail: record.detail ?? "",
                createdAt: record.createdAt,
              })),
            },
          };
        } catch (error) {
          return { ok: false, error: memoryFailure(error) };
        }
      },
    },
    {
      descriptor: {
        name: "memory.save",
        title: "Save a long-term memory note",
        description: "Stores a concise durable note about the user (preferences, facts, decisions) that should be remembered across conversations. Input: { note: string, detail?: string }. Keep the note factual and self-contained. Saving memory does not require confirmation.",
        category: "system",
        executionMode: "write",
        requiredScopes: ["manage:memory"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: memorySaveInputSchema,
      outputSchema: memorySaveOutputSchema,
      execute: async (context, input: MemorySaveInput) => {
        if (context.signal?.aborted) return { ok: false, error: memoryFailure(undefined) };
        try {
          const record = store.create({
            kind: "note",
            summary: input.note,
            ...(input.detail ? { detail: input.detail } : {}),
          });
          return { ok: true, value: { saved: recordOutput(store, record.id) } };
        } catch (error) {
          return { ok: false, error: memoryFailure(error) };
        }
      },
    },
    {
      descriptor: {
        name: "memory.update",
        title: "Update a long-term memory note",
        description: "Corrects or refines an existing long-term memory note by id (from memory.list). Input: { id: string, summary?: string, detail?: string }, at least one field required. Use when the user corrects or extends something already stored; replace the stale summary so contradictory facts are merged, not duplicated.",
        category: "system",
        executionMode: "write",
        requiredScopes: ["manage:memory"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: memoryUpdateInputSchema,
      outputSchema: memoryUpdateOutputSchema,
      execute: async (context, input: MemoryUpdateInput) => {
        if (context.signal?.aborted) return { ok: false, error: memoryFailure(undefined) };
        if (input.summary === undefined && input.detail === undefined) {
          return { ok: false, error: createAgentError({ code: "INVALID_ARGUMENT", message: "Provide at least one of summary or detail." }) };
        }
        try {
          const record = store.update(input.id, {
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
          });
          return { ok: true, value: { updated: recordOutput(store, record.id) } };
        } catch (error) {
          if (error instanceof Error && error.message.includes("was not found")) {
            return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The memory note is no longer available." }) };
          }
          return { ok: false, error: memoryFailure(error) };
        }
      },
    },
    {
      descriptor: {
        name: "memory.delete",
        title: "Delete a long-term memory note",
        description: "Deletes a stored long-term memory note by its id, as returned by memory.list. Input: { id: string }. Only delete a note when the user asks to remove it.",
        category: "system",
        executionMode: "write",
        requiredScopes: ["manage:memory"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: memoryDeleteInputSchema,
      outputSchema: memoryDeleteOutputSchema,
      execute: async (context, input: MemoryDeleteInput) => {
        if (context.signal?.aborted) return { ok: false, error: memoryFailure(undefined) };
        try {
          store.delete(input.id);
          return { ok: true, value: { deleted: true } };
        } catch {
          return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The memory note is no longer available." }) };
        }
      },
    },
  ];
}

const autoReplyDeclinedSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  reason: z.enum(autoReplyDecisionReasons).optional(),
  fromAddress: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(320).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const autoReplyDeclinedSearchOutputSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    accountId: z.string(),
    reason: z.enum(autoReplyDecisionReasons),
    fromAddress: z.string(),
    fromName: z.string(),
    subject: z.string(),
    detail: z.string(),
    occurredAt: z.string(),
  }).strict()),
}).strict();

type AutoReplyDeclinedSearchInput = z.infer<typeof autoReplyDeclinedSearchInputSchema>;

/**
 * Auto-reply decline/failure audit tool. Read-only and confirmation-free: it
 * only reveals why the Agent did not reply to an inbound message.
 */
export function createAutoReplyDecisionTools(store: EncryptedAutoReplyDecisionStore): AgentTool[] {
  return [
    {
      descriptor: {
        name: "auto-reply.declined.search",
        title: "Search declined auto-replies",
        description: "Searches the audit list of inbound messages the Agent did not auto-reply to (screened out, out of scope, low value, rejected confirmations, send failures). Input: { query?: string, reason?: 'screening'|'scope'|'low-value'|'sensitive'|'user-rejected'|'daily-cap'|'llm-failed'|'send-failed'|'no-template'|'expired', fromAddress?: string, subject?: string, limit?: number }. Use when the user asks why no auto-reply was sent to someone, or wants to review skipped messages. Returns the most recent decisions first.",
        category: "system",
        executionMode: "read",
        requiredScopes: ["manage:memory"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: autoReplyDeclinedSearchInputSchema,
      outputSchema: autoReplyDeclinedSearchOutputSchema,
      execute: async (context, input: AutoReplyDeclinedSearchInput) => {
        if (context.signal?.aborted) return { ok: false, error: memoryFailure(undefined) };
        try {
          const records = store.list({
            ...(input.query ? { query: input.query } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          return {
            ok: true,
            value: {
              items: records.map((record) => ({
                id: record.id,
                accountId: record.accountId,
                reason: record.reason,
                fromAddress: record.fromAddress,
                fromName: record.fromName,
                subject: record.subject,
                detail: record.detail,
                occurredAt: record.occurredAt,
              })),
            },
          };
        } catch (error) {
          return { ok: false, error: memoryFailure(error) };
        }
      },
    },
  ];
}
