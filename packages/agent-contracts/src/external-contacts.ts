import { z } from "zod";

/**
 * Versioned wire shapes for the local contacts surface used by the Agent
 * contact tools. Contacts are stored encrypted on this device and are
 * not bound to a mail account, so every shape here is account-independent.
 */
export const EXTERNAL_CONTACTS_CONTRACT_VERSION = 1 as const;

export const externalContactBounds = {
  contactResults: 200,
  contactIdCharacters: 128,
  emailCharacters: 320,
  nameCharacters: 200,
  notesCharacters: 2_000,
  timestampCharacters: 64,
} as const;

export const externalContactIdSchema = z.string().trim().min(1).max(externalContactBounds.contactIdCharacters);

const externalContactTextSchema = (maximum: number) => z.string().max(maximum);

export const externalContactOutputSchema = z.object({
  id: externalContactIdSchema,
  email: z.string().min(1).max(externalContactBounds.emailCharacters),
  name: externalContactTextSchema(externalContactBounds.nameCharacters),
  notes: externalContactTextSchema(externalContactBounds.notesCharacters),
  autoCollected: z.boolean(),
  createdAt: z.string().min(1).max(externalContactBounds.timestampCharacters),
  updatedAt: z.string().min(1).max(externalContactBounds.timestampCharacters),
}).strict();

export const externalContactsSearchInputSchema = z.object({
  query: z.string().trim().max(externalContactBounds.nameCharacters).optional(),
  limit: z.number().int().min(1).max(externalContactBounds.contactResults).optional(),
}).strict();

export const externalContactsSearchOutputSchema = z.object({
  contacts: z.array(externalContactOutputSchema).max(externalContactBounds.contactResults),
  truncated: z.boolean(),
}).strict();

export const externalContactCreateInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(externalContactBounds.emailCharacters),
  name: externalContactTextSchema(externalContactBounds.nameCharacters).optional(),
  notes: externalContactTextSchema(externalContactBounds.notesCharacters).optional(),
}).strict();

export const externalContactCreateOutputSchema = z.object({
  contact: externalContactOutputSchema,
}).strict();

export const externalContactUpdateInputSchema = z.object({
  contactId: externalContactIdSchema,
  email: z.string().trim().toLowerCase().email().max(externalContactBounds.emailCharacters).optional(),
  name: externalContactTextSchema(externalContactBounds.nameCharacters).optional(),
  notes: externalContactTextSchema(externalContactBounds.notesCharacters).optional(),
}).strict().superRefine((input, context) => {
  if (Object.keys(input).length === 1) {
    context.addIssue({
      code: "custom",
      path: ["contactId"],
      message: "An update must change at least one field.",
    });
  }
});

export const externalContactUpdateOutputSchema = z.object({
  contact: externalContactOutputSchema,
}).strict();

export const externalContactDeleteInputSchema = z.object({
  contactId: externalContactIdSchema,
}).strict();

export const externalContactDeleteOutputSchema = z.object({
  contactId: externalContactIdSchema,
  deleted: z.literal(true),
}).strict();

export type ExternalContactOutput = z.infer<typeof externalContactOutputSchema>;
export type ExternalContactsSearchInput = z.infer<typeof externalContactsSearchInputSchema>;
export type ExternalContactsSearchOutput = z.infer<typeof externalContactsSearchOutputSchema>;
export type ExternalContactCreateInput = z.infer<typeof externalContactCreateInputSchema>;
export type ExternalContactCreateOutput = z.infer<typeof externalContactCreateOutputSchema>;
export type ExternalContactUpdateInput = z.infer<typeof externalContactUpdateInputSchema>;
export type ExternalContactUpdateOutput = z.infer<typeof externalContactUpdateOutputSchema>;
export type ExternalContactDeleteInput = z.infer<typeof externalContactDeleteInputSchema>;
export type ExternalContactDeleteOutput = z.infer<typeof externalContactDeleteOutputSchema>;
