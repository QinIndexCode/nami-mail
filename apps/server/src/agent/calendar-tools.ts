import type { z } from "zod";
import type {
  externalCalendarEventOutputSchema} from "@nami/agent-contracts";
import {
  createAgentError,
  externalCalendarBounds,
  externalCalendarCreateInputSchema,
  externalCalendarCreateOutputSchema,
  externalCalendarDeleteInputSchema,
  externalCalendarDeleteOutputSchema,
  externalCalendarListInputSchema,
  externalCalendarListOutputSchema,
  externalCalendarUpdateInputSchema,
  externalCalendarUpdateOutputSchema,
  type AgentError,
} from "@nami/agent-contracts";
import type { AgentTool, ToolExecutionOutcome } from "@nami/agent-core";
import {
  CalendarEventTimeConflictError,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  type CalendarEvent,
} from "../calendar.js";
import {
  createCalendarEventConfirmationPreview,
  deleteCalendarEventConfirmationPreview,
  updateCalendarEventConfirmationPreview,
} from "./confirmation-preview.js";
import type { DatabaseHandle } from "../db.js";

type CalendarListInput = z.infer<typeof externalCalendarListInputSchema>;
type CalendarCreateInput = z.infer<typeof externalCalendarCreateInputSchema>;
type CalendarUpdateInput = z.infer<typeof externalCalendarUpdateInputSchema>;
type CalendarDeleteInput = z.infer<typeof externalCalendarDeleteInputSchema>;
type CalendarEventOutput = z.infer<typeof externalCalendarEventOutputSchema>;
type CalendarListOutput = z.infer<typeof externalCalendarListOutputSchema>;
type CalendarCreateOutput = z.infer<typeof externalCalendarCreateOutputSchema>;
type CalendarUpdateOutput = z.infer<typeof externalCalendarUpdateOutputSchema>;
type CalendarDeleteOutput = z.infer<typeof externalCalendarDeleteOutputSchema>;

function clipped(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function eventOutput(value: CalendarEvent): CalendarEventOutput {
  return {
    id: clipped(value.id, externalCalendarBounds.eventIdCharacters),
    title: clipped(value.title, externalCalendarBounds.titleCharacters),
    description: clipped(value.description, externalCalendarBounds.descriptionCharacters),
    location: clipped(value.location, externalCalendarBounds.locationCharacters),
    startAt: clipped(value.startAt, externalCalendarBounds.timestampCharacters),
    endAt: clipped(value.endAt, externalCalendarBounds.timestampCharacters),
    allDay: value.allDay,
    color: value.color,
    createdAt: clipped(value.createdAt, externalCalendarBounds.timestampCharacters),
    updatedAt: clipped(value.updatedAt, externalCalendarBounds.timestampCharacters),
  };
}

function calendarFailure(error: unknown, signal?: AbortSignal): AgentError {
  if (signal?.aborted) {
    return createAgentError({
      code: "CANCELLED",
      message: "The calendar operation was cancelled.",
      retryable: true,
    });
  }
  if (error instanceof CalendarEventTimeConflictError) {
    return createAgentError({
      code: "INVALID_ARGUMENT",
      message: "The event end time must not precede its start time.",
    });
  }
  return createAgentError({
    code: "TOOL_EXECUTION_FAILED",
    message: "The calendar operation could not complete.",
    retryable: true,
  });
}

function calendarListTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<CalendarListInput, CalendarListOutput> {
  return {
    descriptor: {
      name: "calendar.list",
      title: "List calendar events",
      description: "Lists local calendar events that overlap the optional after/before range (ISO timestamps, exclusive bounds). Returns full event details: id, title, startAt, endAt, allDay, color. Use the returned id for calendar.update/calendar.delete. Input: { after?: string, before?: string, limit?: number (1-200) }.",
      category: "calendar",
      executionMode: "read",
      requiredScopes: ["read:calendar"],
      accountAccess: "none",
      confirmationPolicy: "never",
      availableToExternal: false,
      timeoutMs: 15_000,
    },
    inputSchema: externalCalendarListInputSchema,
    outputSchema: externalCalendarListOutputSchema,
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: calendarFailure(undefined, context.signal) };
      const range = input.after !== undefined || input.before !== undefined
        ? {
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.before !== undefined ? { before: input.before } : {}),
        }
        : undefined;
      const events = listCalendarEvents(db, masterKey, range, input.limit ?? 100);
      return {
        ok: true,
        value: {
          events: events.slice(0, externalCalendarBounds.eventResults).map(eventOutput),
          truncated: events.length > externalCalendarBounds.eventResults,
        },
      };
    },
  };
}

function calendarCreateTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<CalendarCreateInput, CalendarCreateOutput> {
  return {
    descriptor: {
      name: "calendar.create",
      title: "Create a calendar event",
      description: "Creates one local calendar event after a visible confirmation. Input: { title: string, startAt: ISO timestamp, endAt: ISO timestamp, description?: string, location?: string, allDay?: boolean, color?: \"blue\" | \"green\" | \"amber\" | \"red\" | \"purple\" | \"teal\" }. Events are stored encrypted on this device only.",
      category: "calendar",
      executionMode: "write",
      requiredScopes: ["write:calendar"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "create-calendar-event",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalCalendarCreateInputSchema,
    outputSchema: externalCalendarCreateOutputSchema,
    confirmationPreview: (input, locale) => createCalendarEventConfirmationPreview(locale, input),
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: calendarFailure(undefined, context.signal) };
      try {
        const event = createCalendarEvent(db, masterKey, input);
        return { ok: true, value: { event: eventOutput(event) } };
      } catch (error) {
        return { ok: false, error: calendarFailure(error) };
      }
    },
  };
}

function calendarUpdateTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<CalendarUpdateInput, CalendarUpdateOutput> {
  return {
    descriptor: {
      name: "calendar.update",
      title: "Update a calendar event",
      description: "Updates one local calendar event after a visible confirmation. Input: { eventId: string, title?: string, startAt?: ISO timestamp, endAt?: ISO timestamp, description?: string, location?: string, allDay?: boolean, color?: \"blue\" | \"green\" | \"amber\" | \"red\" | \"purple\" | \"teal\" }. At least one field besides eventId must change.",
      category: "calendar",
      executionMode: "write",
      requiredScopes: ["write:calendar"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "update-calendar-event",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalCalendarUpdateInputSchema,
    outputSchema: externalCalendarUpdateOutputSchema,
    confirmationPreview: (input, locale) => updateCalendarEventConfirmationPreview(locale, input),
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: calendarFailure(undefined, context.signal) };
      try {
        const { eventId, ...patch } = input;
        const event = updateCalendarEvent(db, masterKey, eventId, patch);
        if (!event) {
          return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The calendar event is no longer available." }) };
        }
        return { ok: true, value: { event: eventOutput(event) } };
      } catch (error) {
        return { ok: false, error: calendarFailure(error) };
      }
    },
  };
}

function calendarDeleteTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<CalendarDeleteInput, CalendarDeleteOutput> {
  return {
    descriptor: {
      name: "calendar.delete",
      title: "Delete a calendar event",
      description: "Deletes one local calendar event after a visible confirmation. Input: { eventId: string }. The event id comes from calendar.list. This cannot be undone.",
      category: "calendar",
      executionMode: "write",
      requiredScopes: ["write:calendar"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "delete-calendar-event",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalCalendarDeleteInputSchema,
    outputSchema: externalCalendarDeleteOutputSchema,
    confirmationPreview: (input, locale) => deleteCalendarEventConfirmationPreview(locale, input),
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: calendarFailure(undefined, context.signal) };
      try {
        const deleted = deleteCalendarEvent(db, input.eventId);
        if (!deleted) {
          return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The calendar event is no longer available." }) };
        }
        return { ok: true, value: { eventId: input.eventId, deleted: true } };
      } catch (error) {
        return { ok: false, error: calendarFailure(error) };
      }
    },
  };
}

/**
 * Creates the local calendar tools. Calendar events are device-local and
 * encrypted, so the tools take the database handle directly instead of an
 * account-scoped mail facade. The tools are available to the desktop Agent
 * only (not to paired CLI/MCP callers); the write tools require a visible
 * desktop confirmation.
 */
export function createCalendarTools(
  db: DatabaseHandle,
  masterKey: Buffer,
): readonly AgentTool<any, any>[] {
  return [
    calendarListTool(db, masterKey),
    calendarCreateTool(db, masterKey),
    calendarUpdateTool(db, masterKey),
    calendarDeleteTool(db, masterKey),
  ];
}
