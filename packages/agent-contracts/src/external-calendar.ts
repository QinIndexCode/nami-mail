import { z } from "zod";

/**
 * Versioned wire shapes for the local calendar surface used by the Agent
 * calendar tools. Calendar events are stored encrypted on this device and are
 * not bound to a mail account, so every shape here is account-independent.
 * The calendar tools are desktop-only for now; keeping the schemas in the
 * shared contracts package means the desktop Agent and the calendar REST
 * surface cannot drift apart.
 */
export const EXTERNAL_CALENDAR_CONTRACT_VERSION = 1 as const;

export const externalCalendarBounds = {
  eventResults: 200,
  eventIdCharacters: 128,
  titleCharacters: 300,
  descriptionCharacters: 10_000,
  locationCharacters: 500,
  colorCharacters: 16,
  timestampCharacters: 64,
} as const;

export const externalCalendarEventIdSchema = z.string().trim().min(1).max(externalCalendarBounds.eventIdCharacters);

export const externalCalendarColors = ["blue", "green", "amber", "red", "purple", "teal"] as const;

const externalCalendarNonEmptyTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);
const externalCalendarTextSchema = (maximum: number) => z.string().max(maximum);

export const externalCalendarEventOutputSchema = z.object({
  id: externalCalendarEventIdSchema,
  title: externalCalendarTextSchema(externalCalendarBounds.titleCharacters),
  description: externalCalendarTextSchema(externalCalendarBounds.descriptionCharacters),
  location: externalCalendarTextSchema(externalCalendarBounds.locationCharacters),
  startAt: z.string().min(1).max(externalCalendarBounds.timestampCharacters),
  endAt: z.string().min(1).max(externalCalendarBounds.timestampCharacters),
  allDay: z.boolean(),
  color: z.enum(externalCalendarColors),
  createdAt: z.string().min(1).max(externalCalendarBounds.timestampCharacters),
  updatedAt: z.string().min(1).max(externalCalendarBounds.timestampCharacters),
}).strict();

const calendarEventMutationShape = {
  title: externalCalendarNonEmptyTextSchema(externalCalendarBounds.titleCharacters),
  description: externalCalendarTextSchema(externalCalendarBounds.descriptionCharacters).optional(),
  location: externalCalendarTextSchema(externalCalendarBounds.locationCharacters).optional(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().optional(),
  color: z.enum(externalCalendarColors).optional(),
};

function validateCalendarRange(input: { startAt: string; endAt: string }, context: z.RefinementCtx): void {
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    context.addIssue({
      code: "custom",
      path: ["endAt"],
      message: "The event end time must not precede its start time.",
    });
  }
}

export const externalCalendarListInputSchema = z.object({
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(externalCalendarBounds.eventResults).optional(),
}).strict().superRefine((input, context) => {
  // Compare actual instants, not text order: an offset-bearing timestamp such
  // as 2026-07-01T10:00:00+08:00 sorts after 2026-07-01T03:00:00Z lexically
  // while both denote times on the same day. Date.parse normalizes the offset.
  const after = input.after === undefined ? Number.NaN : Date.parse(input.after);
  const before = input.before === undefined ? Number.NaN : Date.parse(input.before);
  if (Number.isFinite(after) && Number.isFinite(before) && after > before) {
    context.addIssue({
      code: "custom",
      path: ["before"],
      message: "The before timestamp must not precede the after timestamp.",
    });
  }
});

export const externalCalendarListOutputSchema = z.object({
  events: z.array(externalCalendarEventOutputSchema).max(externalCalendarBounds.eventResults),
  truncated: z.boolean(),
}).strict();

export const externalCalendarCreateInputSchema = z.object(calendarEventMutationShape).strict().superRefine(validateCalendarRange);
export const externalCalendarCreateOutputSchema = z.object({
  event: externalCalendarEventOutputSchema,
}).strict();

export const externalCalendarUpdateInputSchema = z.object({
  eventId: externalCalendarEventIdSchema,
  title: externalCalendarNonEmptyTextSchema(externalCalendarBounds.titleCharacters).optional(),
  description: externalCalendarTextSchema(externalCalendarBounds.descriptionCharacters).optional(),
  location: externalCalendarTextSchema(externalCalendarBounds.locationCharacters).optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  allDay: z.boolean().optional(),
  color: z.enum(externalCalendarColors).optional(),
}).strict().superRefine((input, context) => {
  if (Object.keys(input).length === 1) {
    context.addIssue({
      code: "custom",
      path: ["eventId"],
      message: "An update must change at least one field.",
    });
  }
  if (input.startAt !== undefined && input.endAt !== undefined) {
    const start = Date.parse(input.startAt);
    const end = Date.parse(input.endAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "The event end time must not precede its start time.",
      });
    }
  }
});
export const externalCalendarUpdateOutputSchema = z.object({
  event: externalCalendarEventOutputSchema,
}).strict();

export const externalCalendarDeleteInputSchema = z.object({
  eventId: externalCalendarEventIdSchema,
}).strict();

export const externalCalendarDeleteOutputSchema = z.object({
  eventId: externalCalendarEventIdSchema,
  deleted: z.literal(true),
}).strict();

export type ExternalCalendarEventOutput = z.infer<typeof externalCalendarEventOutputSchema>;
export type ExternalCalendarListOutput = z.infer<typeof externalCalendarListOutputSchema>;
export type ExternalCalendarCreateOutput = z.infer<typeof externalCalendarCreateOutputSchema>;
export type ExternalCalendarUpdateOutput = z.infer<typeof externalCalendarUpdateOutputSchema>;
export type ExternalCalendarDeleteOutput = z.infer<typeof externalCalendarDeleteOutputSchema>;
