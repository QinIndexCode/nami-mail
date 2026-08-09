import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  templateForId,
  templateUpdateSchema,
  updateTemplate,
} from "../src/templates.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

describe("mail templates", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("creates, lists, updates and deletes templates with encrypted storage", () => {
    const created = createTemplate(db, masterKey, {
      name: "Follow-up",
      subject: "Re: {{topic}}",
      body: "Just following up on the discussion.",
    });
    expect(created.name).toBe("Follow-up");
    expect(created.subject).toBe("Re: {{topic}}");

    // The stored columns are ciphertext, never the plaintext template.
    const row = db.prepare("SELECT name_enc, body_enc FROM mail_templates WHERE id = ?").get(created.id) as { name_enc: string; body_enc: string };
    expect(row.name_enc).not.toContain("Follow-up");
    expect(row.body_enc).not.toContain("following up");
    expect(row.name_enc).toMatch(/^nami-v1\./);

    const listed = listTemplates(db, masterKey);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("Follow-up");

    const updated = updateTemplate(db, masterKey, created.id, { body: "Updated body." });
    expect(updated?.body).toBe("Updated body.");
    expect(updated?.subject).toBe("Re: {{topic}}");

    // Clearing the subject is supported by an explicit empty string.
    const cleared = updateTemplate(db, masterKey, created.id, { subject: "" });
    expect(cleared?.subject).toBe("");

    expect(deleteTemplate(db, created.id)).toBe(true);
    expect(deleteTemplate(db, created.id)).toBe(false);
    expect(listTemplates(db, masterKey)).toHaveLength(0);
    expect(templateForId(db, masterKey, created.id)).toBeUndefined();
  });

  it("searches by case-insensitive substring across the template name", () => {
    createTemplate(db, masterKey, { name: "Weekly Status", body: "This week I..." });
    createTemplate(db, masterKey, { name: "Invoice Reminder", body: "Your invoice is due." });

    expect(listTemplates(db, masterKey, "STATUS").map((template) => template.name)).toEqual(["Weekly Status"]);
    expect(listTemplates(db, masterKey, "invoice").map((template) => template.name)).toEqual(["Invoice Reminder"]);
    expect(listTemplates(db, masterKey, "zzz")).toHaveLength(0);
    expect(listTemplates(db, masterKey)).toHaveLength(2);
  });

  it("exposes CRUD through the local API", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/templates",
      payload: { name: "Reply Thanks", subject: "Thanks", body: "Thank you for the update." },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { ok: boolean; template: { id: string; name: string } };
    expect(createdBody).toMatchObject({ ok: true });
    expect(createdBody.template.name).toBe("Reply Thanks");

    const listed = await app.inject({ method: "GET", url: "/api/templates?q=thanks" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ ok: true });
    expect((listed.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/templates/${createdBody.template.id}`,
      payload: { name: "Reply Thank You" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { template: { name: string } }).template.name).toBe("Reply Thank You");

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/templates/does-not-exist",
      payload: { name: "X" },
    });
    expect(missing.statusCode).toBe(404);

    const deleted = await app.inject({ method: "DELETE", url: `/api/templates/${createdBody.template.id}` });
    expect(deleted.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: "/api/templates" });
    expect((gone.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("validates template input through the strict schema", async () => {
    const missingBody = await app.inject({
      method: "POST",
      url: "/api/templates",
      payload: { name: "No Body" },
    });
    expect(missingBody.statusCode).toBe(400);

    const blankName = await app.inject({
      method: "POST",
      url: "/api/templates",
      payload: { name: "   ", body: "Hello" },
    });
    expect(blankName.statusCode).toBe(400);

    expect(templateUpdateSchema.safeParse({ body: "Renamed body" }).success).toBe(true);
    expect(templateUpdateSchema.safeParse({}).success).toBe(false);
  });
});
