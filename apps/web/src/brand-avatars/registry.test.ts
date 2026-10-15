import { describe, expect, it } from "vitest";
import { getBrandAvatar } from "./registry";

describe("getBrandAvatar", () => {
  it("resolves primary domains to their matching brand avatars", () => {
    const github = getBrandAvatar("notifications@github.com");
    expect(github).toBeDefined();
    expect(github?.id).toBe("github");
    expect(github?.color).toBe("#181717");
    expect(github?.name).toBe("GitHub");

    const apple = getBrandAvatar("orders@apple.com");
    expect(apple?.id).toBe("apple");

    const google = getBrandAvatar("alerts@google.com");
    expect(google?.id).toBe("google");

    const steam = getBrandAvatar("noreply@steampowered.com");
    expect(steam?.id).toBe("steam");
  });

  it("resolves complex subdomains to apex brand avatar", () => {
    const aliyun = getBrandAvatar("service@mail.notice.aliyun.com");
    expect(aliyun?.id).toBe("aliyun");

    const alipay = getBrandAvatar("pay@service.alipay.com");
    expect(alipay?.id).toBe("alipay");

    const appleSub = getBrandAvatar("news@insideapple.apple.com");
    expect(appleSub?.id).toBe("apple");

    const amazonUk = getBrandAvatar("order-update@amazon.co.uk");
    expect(amazonUk?.id).toBe("amazon");
  });

  it("resolves brand aliases properly", () => {
    expect(getBrandAvatar("test@icloud.com")?.id).toBe("apple");
    expect(getBrandAvatar("test@me.com")?.id).toBe("apple");
    expect(getBrandAvatar("test@gmail.com")?.id).toBe("google");
    expect(getBrandAvatar("test@youtube.com")?.id).toBe("google");
    expect(getBrandAvatar("test@hotmail.com")?.id).toBe("microsoft");
    expect(getBrandAvatar("test@outlook.com")?.id).toBe("microsoft");
    expect(getBrandAvatar("test@steamcommunity.com")?.id).toBe("steam");
  });

  it("returns undefined for unknown or unlisted domains", () => {
    expect(getBrandAvatar("user@unknown-domain-12345.xyz")).toBeUndefined();
    expect(getBrandAvatar("admin@mycompany.org")).toBeUndefined();
    expect(getBrandAvatar("")).toBeUndefined();
  });
});
