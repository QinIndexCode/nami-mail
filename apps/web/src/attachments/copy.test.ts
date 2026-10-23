// @vitest-environment node
import { describe, expect, it } from "vitest";
import en from "../locales/en-US.json";
import zh from "../locales/zh-CN.json";

/**
 * Copy contract for the preview drawer (plan §10.3).
 *
 * The drawer reads these keys by their call argument (`t("mail.attachment.x")`),
 * so this test speaks the same form the components use. The point is not that
 * the strings are pretty — it is that the set is exactly 24 keys, that both
 * languages agree on the interpolations, and that no "17th" key slips in
 * alongside the sixteen this feature introduced.
 */

type Pack = { messages: Record<string, unknown> };

/** The sixteen keys S2/S3 introduced. */
const NEW_KEYS = [
  "mail.attachment.previewEncrypted",
  "mail.attachment.previewCorrupt",
  "mail.attachment.previewTimeout",
  "mail.attachment.previewRetry",
  "mail.attachment.previewImageTooLarge",
  "mail.attachment.previewKindMismatch",
  "mail.attachment.previewDownloadOnly",
  "mail.attachment.previewPageOf",
  "mail.attachment.previewPrevPage",
  "mail.attachment.previewNextPage",
  "mail.attachment.previewTooManyPages",
  "mail.attachment.previewTooManyEntries",
  "mail.attachment.previewZipBomb",
  "mail.attachment.previewPageTooLarge",
  "mail.attachment.previewArchiveCount",
  "mail.attachment.previewArchiveNoExtract",
] as const;

/** The eight keys that predate the rework (one of them, `previewTruncated`, was reworded). */
const EXISTING_KEYS = [
  "mail.attachment.previewTitle",
  "mail.attachment.previewResize",
  "mail.attachment.preview",
  "mail.attachment.previewLoading",
  "mail.attachment.previewFailed",
  "mail.attachment.previewUnsupported",
  "mail.attachment.previewTooLarge",
  "mail.attachment.previewTruncated",
] as const;

const EXPECTED_KEYS = [...NEW_KEYS, ...EXISTING_KEYS].sort();

function previewKeys(pack: Pack): string[] {
  return Object.keys(pack.messages).filter((key) => key.startsWith("mail.attachment.preview")).sort();
}

function copyOf(pack: Pack, key: string): string {
  const value = pack.messages[key];
  if (typeof value !== "string") throw new Error(`${key} is missing or not a string`);
  return value;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]!).sort();
}

describe("preview copy", () => {
  it("has exactly the 24 preview keys in both locales", () => {
    expect(previewKeys(zh)).toEqual(EXPECTED_KEYS);
    expect(previewKeys(en)).toEqual(EXPECTED_KEYS);
  });

  it("keeps every new key non-empty in both locales", () => {
    for (const key of NEW_KEYS) {
      expect(copyOf(zh, key).trim(), `zh ${key}`).not.toBe("");
      expect(copyOf(en, key).trim(), `en ${key}`).not.toBe("");
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of EXPECTED_KEYS) {
      expect(placeholders(copyOf(en, key)), key).toEqual(placeholders(copyOf(zh, key)));
    }
  });

  it("documents the placeholders each key needs", () => {
    const expected: Record<string, string[]> = {
      "mail.attachment.preview": ["filename"],
      "mail.attachment.previewTimeout": ["seconds"],
      "mail.attachment.previewImageTooLarge": ["max"],
      "mail.attachment.previewPageOf": ["page", "total"],
      "mail.attachment.previewTooManyPages": ["max"],
      "mail.attachment.previewTooManyEntries": ["max"],
      "mail.attachment.previewArchiveCount": ["count", "size"],
      "mail.attachment.previewTruncated": ["count", "total"],
    };
    for (const [key, names] of Object.entries(expected)) {
      expect(placeholders(copyOf(zh, key)), `zh ${key}`).toEqual(names);
      expect(placeholders(copyOf(en, key)), `en ${key}`).toEqual(names);
    }
  });

  it("no longer carries the demo-unavailable gate", () => {
    for (const pack of [zh, en]) {
      expect(Object.keys(pack.messages)).not.toContain("mail.attachment.previewDemoUnavailable");
    }
  });
});
