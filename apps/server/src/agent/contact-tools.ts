import type {
  ExternalContactCreateInput,
  ExternalContactCreateOutput,
  ExternalContactDeleteInput,
  ExternalContactDeleteOutput,
  ExternalContactOutput,
  ExternalContactsSearchInput,
  ExternalContactsSearchOutput,
  ExternalContactUpdateInput,
  ExternalContactUpdateOutput,
} from "@nami/agent-contracts";
import {
  createAgentError,
  externalContactBounds,
  externalContactCreateInputSchema,
  externalContactCreateOutputSchema,
  externalContactDeleteInputSchema,
  externalContactDeleteOutputSchema,
  externalContactsSearchInputSchema,
  externalContactsSearchOutputSchema,
  externalContactUpdateInputSchema,
  externalContactUpdateOutputSchema,
  type AgentError,
} from "@nami/agent-contracts";
import type { AgentTool } from "@nami/agent-core";
import {
  ContactConflictError,
  contactForId,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
  type Contact,
} from "../contacts.js";
import {
  createContactConfirmationPreview,
  deleteContactConfirmationPreview,
  updateContactConfirmationPreview,
} from "./confirmation-preview.js";
import { clipped } from "./agent-shared.js";
import type { DatabaseHandle } from "../db.js";

function contactOutput(value: Contact): ExternalContactOutput {
  return {
    id: clipped(value.id, externalContactBounds.contactIdCharacters),
    email: clipped(value.email, externalContactBounds.emailCharacters),
    name: clipped(value.name, externalContactBounds.nameCharacters),
    notes: clipped(value.notes, externalContactBounds.notesCharacters),
    autoCollected: value.autoCollected,
    createdAt: clipped(value.createdAt, externalContactBounds.timestampCharacters),
    updatedAt: clipped(value.updatedAt, externalContactBounds.timestampCharacters),
  };
}

function contactFailure(error: unknown, signal?: AbortSignal): AgentError {
  if (signal?.aborted) {
    return createAgentError({
      code: "CANCELLED",
      message: "The contact operation was cancelled.",
      retryable: true,
    });
  }
  if (error instanceof ContactConflictError) {
    return createAgentError({
      code: "CONFLICT",
      message: "A contact with this email address already exists.",
    });
  }
  return createAgentError({
    code: "TOOL_EXECUTION_FAILED",
    message: "The contact operation could not complete.",
    retryable: true,
  });
}

function contactsSearchTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<ExternalContactsSearchInput, ExternalContactsSearchOutput> {
  return {
    descriptor: {
      name: "contacts.search",
      title: "Search address book contacts",
      description: "Searches local address book contacts matching an optional text query (matches name or email substring). Returns matching contacts: id, email, name, notes, autoCollected. Use the returned id for contacts.update/contacts.delete. Input: { query?: string, limit?: number (1-200) }.",
      category: "contacts",
      executionMode: "read",
      requiredScopes: ["read:contacts"],
      accountAccess: "none",
      confirmationPolicy: "never",
      availableToExternal: false,
      timeoutMs: 15_000,
    },
    inputSchema: externalContactsSearchInputSchema,
    outputSchema: externalContactsSearchOutputSchema,
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: contactFailure(undefined, context.signal) };
      const contacts = listContacts(db, masterKey, input.query, input.limit ?? 100);
      return {
        ok: true,
        value: {
          contacts: contacts.slice(0, externalContactBounds.contactResults).map(contactOutput),
          truncated: contacts.length > externalContactBounds.contactResults,
        },
      };
    },
  };
}

function contactCreateTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<ExternalContactCreateInput, ExternalContactCreateOutput> {
  return {
    descriptor: {
      name: "contacts.create",
      title: "Create a contact",
      description: "Creates one contact in the local address book after a visible confirmation. Input: { email: string, name?: string, notes?: string }. Contacts are stored encrypted on this device only.",
      category: "contacts",
      executionMode: "write",
      requiredScopes: ["write:contacts"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "create-contact",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalContactCreateInputSchema,
    outputSchema: externalContactCreateOutputSchema,
    confirmationPreview: (input, locale) => createContactConfirmationPreview(locale, input),
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: contactFailure(undefined, context.signal) };
      try {
        const contact = createContact(db, masterKey, input);
        return { ok: true, value: { contact: contactOutput(contact) } };
      } catch (error) {
        return { ok: false, error: contactFailure(error) };
      }
    },
  };
}

function contactUpdateTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<ExternalContactUpdateInput, ExternalContactUpdateOutput> {
  return {
    descriptor: {
      name: "contacts.update",
      title: "Update a contact",
      description: "Updates one contact in the local address book after a visible confirmation. Input: { contactId: string, email?: string, name?: string, notes?: string }. At least one field besides contactId must be provided.",
      category: "contacts",
      executionMode: "write",
      requiredScopes: ["write:contacts"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "update-contact",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalContactUpdateInputSchema,
    outputSchema: externalContactUpdateOutputSchema,
    confirmationPreview: (input, locale) => updateContactConfirmationPreview(locale, input),
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: contactFailure(undefined, context.signal) };
      try {
        const { contactId, ...patch } = input;
        const contact = updateContact(db, masterKey, contactId, patch);
        if (!contact) {
          return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The contact is no longer available." }) };
        }
        return { ok: true, value: { contact: contactOutput(contact) } };
      } catch (error) {
        return { ok: false, error: contactFailure(error) };
      }
    },
  };
}

function contactDeleteTool(db: DatabaseHandle, masterKey: Buffer): AgentTool<ExternalContactDeleteInput, ExternalContactDeleteOutput> {
  return {
    descriptor: {
      name: "contacts.delete",
      title: "Delete a contact",
      description: "Deletes one contact from the local address book after a visible confirmation. Input: { contactId: string }. The contact id comes from contacts.search. This cannot be undone.",
      category: "contacts",
      executionMode: "write",
      requiredScopes: ["write:contacts"],
      accountAccess: "none",
      confirmationPolicy: "required",
      confirmationAction: "delete-contact",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: externalContactDeleteInputSchema,
    outputSchema: externalContactDeleteOutputSchema,
    confirmationPreview: (input, locale) => {
      const existing = contactForId(db, masterKey, input.contactId);
      return deleteContactConfirmationPreview(locale, {
        contactId: input.contactId,
        name: existing?.name,
        email: existing?.email,
      });
    },
    execute: async (context, input) => {
      if (context.signal?.aborted) return { ok: false, error: contactFailure(undefined, context.signal) };
      try {
        const deleted = deleteContact(db, input.contactId);
        if (!deleted) {
          return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The contact is no longer available." }) };
        }
        return { ok: true, value: { contactId: input.contactId, deleted: true } };
      } catch (error) {
        return { ok: false, error: contactFailure(error) };
      }
    },
  };
}

/**
 * Creates the local contacts tools. Contacts are device-local and
 * encrypted, so the tools take the database handle directly instead of an
 * account-scoped mail facade. The tools are available to the desktop Agent
 * only; write tools require a visible desktop confirmation.
 */
export function createContactTools(
  db: DatabaseHandle,
  masterKey: Buffer,
): readonly AgentTool<any, any>[] {
  return [
    contactsSearchTool(db, masterKey),
    contactCreateTool(db, masterKey),
    contactUpdateTool(db, masterKey),
    contactDeleteTool(db, masterKey),
  ];
}
