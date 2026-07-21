import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "../src/db.js";

async function loadOAuthModule() {
  vi.resetModules();
  return import("../src/oauth.js");
}

function callbackFor(state: string, suffix: string): URL {
  const callback = new URL("http://127.0.0.1:43125/api/oauth/google/callback");
  callback.searchParams.set("code", `authorization-code-for-${suffix}`);
  callback.searchParams.set("state", state);
  return callback;
}

beforeEach(() => {
  vi.stubEnv("NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID", "google-client-for-tests");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OAuth transport error presentation", () => {
  it("records a safe network code instead of a raw token-exchange socket error", async () => {
    const { OAuthService } = await loadOAuthModule();
    // These failures occur before an account is persisted, so the test can
    // isolate presentation behavior without loading the native SQLite module.
    const service = new OAuthService({} as DatabaseHandle, randomBytes(32));
    const started = await service.start("google", "http://127.0.0.1:43125");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const secret = "do-not-expose-this-token";
    const internals = service as unknown as {
      callbackTokens: () => Promise<{ tokens: { access_token: string; refresh_token: string; expires_in: number } }>;
    };
    vi.spyOn(internals, "callbackTokens").mockRejectedValueOnce(
      Object.assign(new Error(`connect ENETUNREACH token=${secret}`), { code: "ENETUNREACH" }),
    );

    await expect(service.finish("google", callbackFor(state!, "network-check"))).rejects.toMatchObject({ code: "network_unavailable" });
    expect(service.getAttempt(started.attemptId)).toMatchObject({
      status: "error",
      code: "network_unavailable",
    });
    expect(service.getAttempt(started.attemptId).message).not.toContain(secret);
  });

  it("does not expose a provider error_description in a failed authorization attempt", async () => {
    const { OAuthService } = await loadOAuthModule();
    const service = new OAuthService({} as DatabaseHandle, randomBytes(32));
    const started = await service.start("google", "http://127.0.0.1:43125");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const secret = "do-not-expose-this-provider-description";
    const internals = service as unknown as {
      callbackTokens: () => Promise<never>;
    };
    vi.spyOn(internals, "callbackTokens").mockRejectedValueOnce({
      error: "server_error",
      error_description: `provider diagnostic ${secret}`,
    });

    await expect(service.finish("google", callbackFor(state!, "redaction-check"))).rejects.toMatchObject({ code: "oauth_failed" });
    expect(service.getAttempt(started.attemptId).message).not.toContain(secret);
  });
});
