import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  hasUnsavedTranslationConfiguration,
  translationConfigurationErrorMessage,
  translationConfigurationStatusMessage,
  translationErrorMessage,
} from "./translationPresentation";

const keyOnly = (key: string) => key;

describe("translation error presentation", () => {
  it("maps stable local API errors to localized recovery keys", () => {
    expect(translationErrorMessage(new ApiError("Timed out", "translation_timeout", 504), keyOnly))
      .toBe("translation.error.timeout");
    expect(translationErrorMessage(new ApiError("Too large", "translation_response_too_large", 502), keyOnly))
      .toBe("translation.error.responseTooLarge");
    expect(translationErrorMessage(new Error("unexpected"), keyOnly)).toBe("translation.error.failed");
  });

  it.each([
    ["translation_tls_certificate_failed", "translation.error.tlsCertificate"],
    ["translation_server_not_found", "translation.error.serverNotFound"],
    ["translation_connection_refused", "translation.error.connectionRefused"],
    ["translation_service_authentication_failed", "translation.error.serviceAuthentication"],
    ["translation_rate_limited", "translation.error.rateLimited"],
    ["local_service_unavailable", "translation.error.localServiceUnavailable"],
  ])("maps %s to an actionable translation recovery message", (code, expected) => {
    expect(translationErrorMessage(new ApiError("internal transport detail", code, 502), keyOnly)).toBe(expected);
  });

  it("maps configuration failures to local recovery guidance without using server wording", () => {
    expect(translationConfigurationErrorMessage(new ApiError("Endpoint details", "translation_configuration_invalid", 400), keyOnly))
      .toBe("settings.translation.configurationInvalid");
    expect(translationConfigurationErrorMessage(new Error("unexpected"), keyOnly)).toBe("settings.translation.saveFailed");
    expect(translationConfigurationErrorMessage(new Error("unexpected"), keyOnly, "settings.translation.loadFailed"))
      .toBe("settings.translation.loadFailed");
  });

  it("explains unreadable and invalid saved configuration without exposing a key", () => {
    const base = {
      ok: true as const,
      enabled: false,
      endpoint: "",
      timeoutMs: 25_000,
      apiKeyConfigured: false,
      source: "local" as const,
    };

    expect(translationConfigurationStatusMessage({ ...base, configurationError: "unreadable" }, keyOnly))
      .toBe("settings.translation.configurationUnreadable");
    expect(translationConfigurationStatusMessage({ ...base, configurationError: "invalid" }, keyOnly))
      .toBe("settings.translation.configurationInvalid");
    expect(translationConfigurationStatusMessage({ ...base, source: "none" }, keyOnly))
      .toBe("settings.translation.source.none");
  });

  it("keeps unsaved service fields visible until the user saves or explicitly discards them", () => {
    const configuration = {
      ok: true as const,
      enabled: true,
      endpoint: "https://translate.example.test/translate",
      timeoutMs: 25_000,
      apiKeyConfigured: true,
      source: "local" as const,
    };

    expect(hasUnsavedTranslationConfiguration(configuration, {
      endpoint: " https://translate.example.test/translate ",
      apiKey: "",
      timeoutMs: 25_000,
    })).toBe(false);
    expect(hasUnsavedTranslationConfiguration(configuration, {
      endpoint: "https://translate.example.test/translate",
      apiKey: "replacement-key",
      timeoutMs: 25_000,
    })).toBe(true);
  });
});
