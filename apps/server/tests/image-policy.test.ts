import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { seedRecoveryFixture } from "./helpers/recovery-fixture.js";
import { proxyImage } from "../src/image-proxy.js";
import type { FastifyInstance } from "fastify";
vi.mock("../src/image-proxy.js", () => ({ proxyImage: vi.fn(async () => ({ contentType: "image/png", content: Buffer.from("fixture") })) }));
describe("remote image authorization", () => {
  let db: DatabaseHandle; let app: FastifyInstance;
  const key = Buffer.alloc(32, 19);
  const image = "/api/images/proxy?url=https%3A%2F%2Fimage.example.test%2Fpixel.png&messageId=message";
  beforeEach(async () => { vi.clearAllMocks(); db = openDatabase(":memory:"); seedRecoveryFixture(db, key); app = await buildApp({ db, masterKey: key }); });
  afterEach(async () => { await app.close(); db.close(); });
  it("performs no upstream request until a message is allowed and stops after revocation", async () => {
    expect((await app.inject({ method: "POST", url: "/api/messages/message/images/allow" })).statusCode).toBe(400);
    expect((await app.inject({ url: image })).statusCode).toBe(403); expect(proxyImage).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/api/messages/message/images/allow", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: image })).statusCode).toBe(200); expect(proxyImage).toHaveBeenCalledTimes(1);
    await app.inject({ method: "DELETE", url: "/api/messages/message/images/allow" });
    expect((await app.inject({ url: image })).statusCode).toBe(403); expect(proxyImage).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: image.replace("messageId=message", "messageId=other") })).statusCode).toBe(403);
  });
  it("seals sender trust, reuses it, and supports removing trust", async () => {
    await app.inject({ method: "POST", url: "/api/messages/message/images/allow", payload: { trustSender: true } });
    expect((await app.inject({ url: image })).statusCode).toBe(200);
    expect(JSON.stringify(db.prepare("SELECT * FROM image_policy").all())).not.toContain("ada@example.test");
    expect((await app.inject({ url: "/api/image-policy" })).json()).toEqual({ mode: "block", trustedSenders: ["ada@example.test"] });
    await app.inject({ method: "PATCH", url: "/api/image-policy", payload: { mode: "block", trustedSenders: [] } });
    expect((await app.inject({ url: image })).statusCode).toBe(403);
  });
  it("can revoke all message grants and rejects authorizing a missing message", async () => {
    await app.inject({ method: "POST", url: "/api/messages/message/images/allow", payload: {} });
    await app.inject({ method: "DELETE", url: "/api/image-policy/grants" });
    expect((await app.inject({ url: image })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/messages/missing/images/allow", payload: {} })).statusCode).toBe(404);
  });
});
