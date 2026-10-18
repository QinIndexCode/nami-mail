import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrandIconRecord } from "./types";
import { BRAND_DEFINITIONS, DOMAIN_TO_BRAND, getBrandAvatar } from "./registry";
import iconData from "./icons.json";

/**
 * The audited allowlist, mirrored here on purpose. The app ships a bundled glyph only for
 * a brand whose owner publishes an affirmative grant of referential logo use, so widening
 * this set is a legal decision that should have to edit a test that says so.
 */
const AUDITED_IDS = ["figma", "openai", "paypal", "telegram"];

/**
 * The audit's negative record: the brands this app used to bundle and then removed. Keeping
 * the names here means one cannot quietly come back - re-adding a vendor has to delete it
 * from this list in the same commit, which is the review moment the audit exists to create.
 */
const DROPPED_IDS = [
  "alipay",
  "aliyun",
  "amazon",
  "anthropic",
  "apple",
  "baidu",
  "bilibili",
  "cloudflare",
  "cmb",
  "discord",
  "docker",
  "epicgames",
  "feishu",
  "github",
  "gitlab",
  "google",
  "jd",
  "meituan",
  "microsoft",
  "netease",
  "netflix",
  "notion",
  "qq",
  "slack",
  "spotify",
  "steam",
  "stripe",
  "taobao",
  "tencent",
  "vercel",
  "wechat",
  "weibo",
  "zhihu",
  "zoom",
];

/**
 * Every domain those brands used to resolve through. Checked as well as the ids, so that
 * bringing a vendor back under a sibling domain (say `githubstatus.com`) fails too.
 */
const DROPPED_DOMAINS = [
  "126.com",
  "163.com",
  "aliexpress.com",
  "alipay.com",
  "aliyun.com",
  "amazon.cn",
  "amazon.co.jp",
  "amazon.co.uk",
  "amazon.com",
  "amazon.de",
  "amazonaws.com",
  "anthropic.com",
  "apple.com",
  "azure.com",
  "baidu.com",
  "bilibili.com",
  "blogger.com",
  "bytedance.com",
  "cloudflare.com",
  "cloudflarestatus.com",
  "cmbchina.com",
  "dianping.com",
  "discord.com",
  "discordapp.com",
  "docker.com",
  "epicgames.com",
  "feishu.cn",
  "foxmail.com",
  "gmail.com",
  "github.com",
  "githubstatus.com",
  "gitlab.com",
  "google.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "jd.com",
  "jd.com.cn",
  "larksuite.com",
  "live.com",
  "me.com",
  "meituan.com",
  "microsoft.com",
  "msn.com",
  "netease.com",
  "netflix.com",
  "notion.com",
  "notion.so",
  "office.com",
  "office365.com",
  "outlook.com",
  "qq.com",
  "sina.cn",
  "sina.com",
  "slack.com",
  "spotify.com",
  "steamcommunity.com",
  "steampowered.com",
  "stripe.com",
  "taobao.com",
  "tencent.com",
  "tmall.com",
  "valvesoftware.com",
  "vercel.com",
  "wechat.com",
  "weibo.com",
  "weixin.qq.com",
  "yeah.net",
  "youtube.com",
  "zhihu.com",
  "zoom.us",
];

const ICONS: Record<string, BrandIconRecord> = iconData.icons;

describe("getBrandAvatar", () => {
  it("resolves primary domains to their matching brand avatars", () => {
    const figma = getBrandAvatar("no-reply@figma.com");
    expect(figma).toBeDefined();
    expect(figma?.id).toBe("figma");
    expect(figma?.color).toBe("#F24E1E");
    expect(figma?.name).toBe("Figma");

    expect(getBrandAvatar("noreply@openai.com")?.id).toBe("openai");
    expect(getBrandAvatar("service@paypal.com")?.id).toBe("paypal");
  });

  it("resolves complex subdomains to the apex brand avatar", () => {
    expect(getBrandAvatar("service@mail.notice.paypal.com")?.id).toBe("paypal");
    expect(getBrandAvatar("login@mail.telegram.org")?.id).toBe("telegram");
  });

  it("resolves brand aliases properly", () => {
    expect(getBrandAvatar("test@t.me")?.id).toBe("telegram");
  });

  it("resolves no pruned vendor through the resolver", () => {
    const pruned = [
      "someone@gmail.com",
      "someone@mail.notice.outlook.com",
      "someone@apple.com",
      "someone@github.com",
      "someone@amazon.co.uk",
      "someone@qq.com",
      "someone@163.com",
      "someone@slack.com",
      "someone@zoom.us",
      "someone@notion.so",
      "someone@steampowered.com",
      "someone@stripe.com",
      "someone@wechat.com",
    ];
    for (const address of pruned) {
      expect(getBrandAvatar(address), address).toBeUndefined();
    }
  });

  it("returns undefined for unknown or unlisted domains", () => {
    expect(getBrandAvatar("user@unknown-domain-12345.xyz")).toBeUndefined();
    expect(getBrandAvatar("admin@mycompany.org")).toBeUndefined();
    // An address with no host is reachable from a malformed From header, and it is what the
    // resolver's empty-root-domain guard is for.
    expect(getBrandAvatar("someone@")).toBeUndefined();
    expect(getBrandAvatar("")).toBeUndefined();
  });
});

/**
 * The mapping and the definitions are two separate tables, so they can drift apart:
 * a domain pointing at a brand that was never defined simply resolves to no avatar,
 * silently, and the sender falls back to a plain initial.
 */
describe("brand registry integrity", () => {
  it("ships exactly the audited brands and nothing else", () => {
    expect(Object.keys(BRAND_DEFINITIONS).sort()).toEqual([...AUDITED_IDS].sort());
  });

  it("defines no dropped brand", () => {
    expect(DROPPED_IDS.filter((id) => BRAND_DEFINITIONS[id])).toEqual([]);
  });

  it("maps no dropped brand's domain", () => {
    expect(DROPPED_DOMAINS.filter((domain) => DOMAIN_TO_BRAND[domain])).toEqual([]);
  });

  it("maps every domain to a brand that actually exists", () => {
    const dangling = [...new Set(Object.values(DOMAIN_TO_BRAND))].filter(
      (brandId) => !BRAND_DEFINITIONS[brandId],
    );
    expect(dangling).toEqual([]);
  });

  it("reaches every defined brand from at least one domain", () => {
    const mapped = new Set(Object.values(DOMAIN_TO_BRAND));
    const unreachable = Object.keys(BRAND_DEFINITIONS).filter((id) => !mapped.has(id));
    expect(unreachable).toEqual([]);
  });

  it("gives every brand a curated name, a color and a glyph", () => {
    for (const [id, brand] of Object.entries(BRAND_DEFINITIONS)) {
      expect(brand.id, `${id} keeps its key as its id`).toBe(id);
      // A missing name would leave the raw id standing in as the brand's name.
      expect(brand.name, `${id} has a curated name`).not.toBe(id);
      expect(brand.color, `${id} has a real color`).toMatch(/^#[0-9A-F]{6}$/i);
      expect(brand.svgPath.length, `${id} has a glyph`).toBeGreaterThan(20);
    }
  });
});

/**
 * The allowlist in the sync script is the audit - the file that says why each brand may ship
 * - and icons.json is its output. Nothing else ties the two together, so this reads the
 * script's source directly: it cannot be imported, because importing it would run the sync,
 * network included.
 */
describe("the shipped set is the audited set", () => {
  function allowlistEntries(): { id: string; slug: string }[] {
    const source = readFileSync(new URL("../../scripts/sync-brand-icons.mjs", import.meta.url), "utf8");
    const block = /const AUDITED_ALLOWLIST = \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
    // Every entry is one `  id: {` line whose first four-space `slug` is its own; no other
    // two-space key exists in the block.
    return [...block.matchAll(/^ {2}([a-z][a-z0-9]*): \{[\s\S]*?\n {4}slug: "([^"]+)"/gm)].map(
      (match) => ({ id: match[1], slug: match[2] }),
    );
  }

  it("matches the allowlist in the sync script, and this test's mirror of it", () => {
    const entries = allowlistEntries();
    // A reformat that hides the entries would make every assertion below pass by finding
    // nothing, so the parse itself is checked first.
    expect(entries.length).toBe(AUDITED_IDS.length);
    const ids = entries.map((entry) => entry.id);
    expect([...ids].sort()).toEqual([...AUDITED_IDS].sort());

    // The regenerated file has to agree with the allowlist, in ids and in slugs: editing an
    // entry without re-running the script ships a glyph the audit no longer describes, and
    // that edit is invisible to everything else in this suite.
    const shipped = Object.entries(ICONS).map(([id, icon]) => ({ id, slug: icon.slug }));
    expect(shipped.map((icon) => icon.id).sort()).toEqual([...ids].sort());
    expect(shipped.map((icon) => icon.slug).sort()).toEqual(entries.map((entry) => entry.slug).sort());
  });
});

/**
 * Every glyph is extracted from simple-icons by apps/web/scripts/sync-brand-icons.mjs, and
 * the registry used to carry hand-written paths next to upstream ones. These assertions do
 * not re-derive the glyphs - that needs the network and is what the script is for - they pin
 * the provenance label, the shape and the licensing, so an entry that was never extracted
 * has to carry a false `source` to pass.
 */
describe("icon provenance", () => {
  it("takes every shipped glyph from simple-icons", () => {
    for (const [id, icon] of Object.entries(ICONS)) {
      expect(icon.source, id).toBe("simple-icons");
      expect(icon.path.length, `${id} has real path data`).toBeGreaterThan(20);
    }
  });

  it("records which script produced the file, and under what license", () => {
    expect(iconData._generated.by).toBe("apps/web/scripts/sync-brand-icons.mjs");
    expect(iconData._generated.source).toBe("simple-icons");
    expect(iconData._generated.license).toBe("CC0-1.0");
    expect(iconData._generated.defaultVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names the release each glyph came from", () => {
    for (const [id, icon] of Object.entries(ICONS)) {
      expect(icon.version, `${id} names a release`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("has an upstream color for every glyph, so the grey fallback never renders", () => {
    // A glyph whose upstream metadata could not be read would ship the fallback color,
    // which looks deliberate in the UI - so no shipped brand may wear it.
    for (const [id, icon] of Object.entries(ICONS)) {
      expect(icon.hex, id).toMatch(/^#[0-9A-F]{6}$/);
    }
    for (const [id, brand] of Object.entries(BRAND_DEFINITIONS)) {
      expect(brand.color, `${id} wears its own color`).not.toBe("#4B5563");
    }
  });
});
