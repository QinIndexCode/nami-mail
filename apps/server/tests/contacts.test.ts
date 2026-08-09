import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  ContactConflictError,
  autoCollectSender,
  contactForId,
  contactUpdateSchema,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from "../src/contacts.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

describe("contacts", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("creates, lists, updates and deletes contacts with encrypted storage", () => {
    const created = createContact(db, masterKey, {
      email: "Alice@Example.com",
      name: "Alice",
    });
    expect(created.email).toBe("alice@example.com");
    expect(created.autoCollected).toBe(false);
    expect(created.notes).toBe("");

    // The stored column is ciphertext, never the plaintext address.
    const row = db.prepare("SELECT email_enc FROM contacts WHERE id = ?").get(created.id) as { email_enc: string };
    expect(row.email_enc).not.toContain("alice@example.com");
    expect(row.email_enc).toMatch(/^nami-v1\./);

    const listed = listContacts(db, masterKey);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.email).toBe("alice@example.com");

    const updated = updateContact(db, masterKey, created.id, { name: "Alice L.", notes: "design team" });
    expect(updated?.name).toBe("Alice L.");
    expect(updated?.notes).toBe("design team");

    expect(deleteContact(db, created.id)).toBe(true);
    expect(deleteContact(db, created.id)).toBe(false);
    expect(listContacts(db, masterKey)).toHaveLength(0);
  });

  it("rejects duplicate emails on create and on update", () => {
    createContact(db, masterKey, { email: "dup@example.com" });
    expect(() => createContact(db, masterKey, { email: "DUP@example.com" })).toThrow(ContactConflictError);

    const other = createContact(db, masterKey, { email: "other@example.com" });
    expect(() => updateContact(db, masterKey, other.id, { email: "dup@example.com" })).toThrow(ContactConflictError);
    // Updating a contact to its own email is not a conflict.
    expect(updateContact(db, masterKey, other.id, { email: "OTHER@example.com" })?.email).toBe("other@example.com");
  });

  it("searches by case-insensitive substring across name and email", () => {
    createContact(db, masterKey, { email: "alice@example.com", name: "Alice L." });
    createContact(db, masterKey, { email: "bob@example.com", name: "Bob" });

    expect(listContacts(db, masterKey, "ALICE").map((contact) => contact.email)).toEqual(["alice@example.com"]);
    expect(listContacts(db, masterKey, "bob").map((contact) => contact.email)).toEqual(["bob@example.com"]);
    expect(listContacts(db, masterKey, "example.com")).toHaveLength(2);
    expect(listContacts(db, masterKey, "zzz")).toHaveLength(0);
    expect(listContacts(db, masterKey)).toHaveLength(2);
  });

  it("auto-collects senders, dedupes, fills missing names, and never collects the user's own address", () => {
    const first = autoCollectSender(db, masterKey, "News@Example.com", "Newsletter", ["me@example.com"]);
    expect(first.email).toBe("news@example.com");
    expect(first.autoCollected).toBe(true);

    // Same sender again keeps the single row and does not clobber the name.
    const again = autoCollectSender(db, masterKey, "news@example.com", "Renamed", ["me@example.com"]);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Newsletter");

    // An unnamed repeat gains a name.
    const unnamed = autoCollectSender(db, masterKey, "no-name@example.com", "", ["me@example.com"]);
    expect(unnamed.name).toBe("");
    const named = autoCollectSender(db, masterKey, "no-name@example.com", "Now Named", ["me@example.com"]);
    expect(named.id).toBe(unnamed.id);
    expect(named.name).toBe("Now Named");

    // The user's own mailbox is never seeded.
    expect(() => autoCollectSender(db, masterKey, "ME@example.com", "Me", ["me@example.com"])).toThrow(ContactConflictError);
    expect(listContacts(db, masterKey).map((contact) => contact.email)).not.toContain("me@example.com");
  });

  it("exposes CRUD and search through the local API with friendly conflicts", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { email: "api@example.com", name: "API User" },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { ok: boolean; contact: { id: string; email: string } };
    expect(createdBody).toMatchObject({ ok: true });
    expect(createdBody.contact.email).toBe("api@example.com");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/contacts",
      payload: { email: "API@example.com" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "contact_exists" });

    const listed = await app.inject({ method: "GET", url: "/api/contacts?q=api" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ ok: true });
    expect((listed.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${createdBody.contact.id}`,
      payload: { name: "API Updated" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { contact: { name: string } }).contact.name).toBe("API Updated");

    const deleted = await app.inject({ method: "DELETE", url: `/api/contacts/${createdBody.contact.id}` });
    expect(deleted.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: "/api/contacts" });
    expect((gone.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("validates contact input through the strict schema", () => {
    expect(contactUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(contactUpdateSchema.safeParse({}).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(contactForId(db, masterKey, "missing")).toBeUndefined();
  });
});
