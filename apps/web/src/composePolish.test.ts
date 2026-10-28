import { describe, expect, it } from "vitest";
import { ApiError } from "./apiTransport";
import { polishErrorMessage } from "./composePolish";

const keyOnly = (key: string) => key;

describe("composePolish error presentation", () => {
  it.each([
    ["no_model_configured", undefined, "compose.polish.needsModel"],
    ["polish_timeout", 504, "compose.polish.error.timeout"],
    ["PROVIDER_TIMEOUT", 504, "compose.polish.error.timeout"],
    [undefined, 504, "compose.polish.error.timeout"],
    ["PROVIDER_UNAVAILABLE", 503, "compose.polish.error.serviceUnavailable"],
    ["HOST_UNAVAILABLE", 503, "compose.polish.error.serviceUnavailable"],
    ["TRANSPORT_UNAVAILABLE", 503, "compose.polish.error.serviceUnavailable"],
    [undefined, 503, "compose.polish.error.serviceUnavailable"],
    ["PROVIDER_AUTH_FAILED", 401, "compose.polish.error.authFailed"],
    [undefined, 401, "compose.polish.error.authFailed"],
    ["PROVIDER_RATE_LIMITED", 429, "compose.polish.error.rateLimited"],
    [undefined, 429, "compose.polish.error.rateLimited"],
    ["CLOUD_CONTENT_CONSENT_REQUIRED", 403, "compose.polish.error.cloudConsent"],
    ["CONTEXT_TOO_LARGE", 413, "compose.polish.error.contextTooLarge"],
    ["payload_too_large", 413, "compose.polish.error.contextTooLarge"],
    [undefined, 413, "compose.polish.error.contextTooLarge"],
    ["polish_invalid_response", 502, "compose.polish.error.invalidResponse"],
    ["local_service_unavailable", 503, "translation.error.localServiceUnavailable"],
    ["local_service_timeout", 504, "translation.error.localServiceUnavailable"],
    ["PROVIDER_ERROR", 502, "compose.polish.failed"],
    [undefined, undefined, "compose.polish.failed"],
  ] as const)("maps code %s status %s to %s", (code, status, expectedKey) => {
    const error = new ApiError("Error occurred", code ?? undefined, status ?? undefined);
    expect(polishErrorMessage(error, keyOnly)).toBe(expectedKey);
  });

  it("handles non-ApiError objects and unexpected exceptions cleanly", () => {
    expect(polishErrorMessage(new Error("network error"), keyOnly)).toBe("compose.polish.failed");
    expect(polishErrorMessage({ code: "PROVIDER_TIMEOUT" }, keyOnly)).toBe("compose.polish.error.timeout");
    expect(polishErrorMessage({ status: 504 }, keyOnly)).toBe("compose.polish.error.timeout");
    expect(polishErrorMessage(null, keyOnly)).toBe("compose.polish.failed");
  });
});
