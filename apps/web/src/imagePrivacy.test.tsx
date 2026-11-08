// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { rewriteRemoteImagesToProxy, sanitizeMailHtml } from "./app/app-utils";
describe("mail image privacy rewriting", () => {
  it("blocks remote src, srcset, backgrounds and escaped CSS while retaining inline image bytes", () => {
    const source = sanitizeMailHtml('<img src="https://remote.test/a"><img src="data:image/png;base64,AA=="><picture><source srcset="https://remote.test/b 2x"></picture><div background="https://remote.test/c" style="background-image:url(\\68 ttps://remote.test/d)">body</div>', false);
    const blocked = rewriteRemoteImagesToProxy(source, { allowRemote: false, messageId: "current" });
    expect(blocked).not.toContain("remote.test"); expect(blocked).not.toContain("/api/images/proxy");
    expect(blocked).toContain("data:image/png;base64,AA==");
    expect(blocked).toContain("body");
  });
  it("rebinds an author-supplied proxy URL to the current message and blocks it before consent", () => {
    const source = '<img src="/api/images/proxy?url=https%3A%2F%2Fremote.test%2Fpixel&amp;messageId=other-authorized-message">';
    const allowed = rewriteRemoteImagesToProxy(source, { allowRemote: true, messageId: "current" });
    expect(allowed).toContain("messageId=current"); expect(allowed).not.toContain("other-authorized-message");
    expect(rewriteRemoteImagesToProxy(source, { allowRemote: false, messageId: "current" })).not.toContain("/api/images/proxy");
  });
});
