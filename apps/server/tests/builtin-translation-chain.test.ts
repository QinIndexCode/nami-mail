import { describe, expect, it } from "vitest";
import { BuiltinTranslationChain, BuiltinTranslationService } from "../src/builtin-translation.js";

describe("BuiltinTranslationChain routing", () => {
  it("routes through Google when it is the primary provider", async () => {
    const calls: string[] = [];
    const builtin = new BuiltinTranslationService({
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("googleapis")) {
          // Google returns a nested-array payload.
          return new Response(JSON.stringify([[[["Hola", "Hello", null, null, 1]]], null, "en"]), { status: 200 });
        }
        if (url.includes("mymemory")) {
          return new Response(JSON.stringify({ responseData: { translatedText: "Hola" } }), { status: 200 });
        }
        throw new Error("unknown engine");
      },
    });
    // Reflect the builtin instance into the chain for deterministic testing.
    const chain = new BuiltinTranslationChain("google", "mymemory");
    (chain as unknown as { builtin: typeof builtin }).builtin = builtin;

    const result = await chain.translate("Hello", "es");
    expect(result.translatedText).toBe("Hola");
    expect(calls[0]).toContain("googleapis");
  });

  it("is always considered configured (built-in chain needs no setup)", () => {
    expect(new BuiltinTranslationChain("google", "mymemory").isConfigured()).toBe(true);
    expect(new BuiltinTranslationChain("custom", "google", { endpoint: "https://custom.example.test/translate", timeoutMs: 5_000 }).isConfigured()).toBe(true);
  });
});
