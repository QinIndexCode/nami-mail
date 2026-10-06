// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collapseQuotedMailHtml, rewriteRemoteImagesToProxy, sanitizeMailHtml, splitBodyLinks, splitQuotedMailText } from "./app-utils";

/** The exact shape the reader must emit for a remote image. */
const proxyUrl = (remote: string) => `/api/images/proxy?url=${encodeURIComponent(remote)}`;

describe("collapseQuotedMailHtml", () => {
  it("folds a top-level blockquote into a details toggle", () => {
    const html = "<p>Reply text</p><blockquote><p>quoted history</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "显示引用的原文");
    expect(folded).toContain('<details class="mail-quote"><summary>显示引用的原文</summary>');
    expect(folded).toContain("<blockquote><p>quoted history</p></blockquote>");
    expect(folded).toContain("<p>Reply text</p>");
  });

  it("folds a gmail_quote wrapper as one block without double-wrapping its inner blockquote", () => {
    const html = '<p>Reply</p><div class="gmail_quote"><div class="gmail_attr">On … wrote:</div><blockquote><p>quoted</p></blockquote></div>';
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
    expect(folded).toContain("On … wrote:");
    expect(folded).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("folds only the outermost quote when quotes are nested", () => {
    const html = "<p>Reply</p><blockquote><p>first</p><blockquote><p>second</p></blockquote></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
  });

  it("folds each sibling quote at its original position", () => {
    const html = "<blockquote><p>q1</p></blockquote><p>middle</p><blockquote><p>q2</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(2);
    expect(folded.indexOf("middle")).toBeGreaterThan(folded.indexOf("q1"));
    expect(folded.indexOf("q2")).toBeGreaterThan(folded.indexOf("middle"));
  });

  it("returns the input unchanged when there is nothing to fold", () => {
    const html = "<p>Just a message.</p>";
    expect(collapseQuotedMailHtml(html, "Show quoted text")).toBe(html);
    expect(collapseQuotedMailHtml("", "Show quoted text")).toBe("");
  });
});

describe("splitQuotedMailText", () => {
  it('splits a trailing ">" quote block, including blank lines inside it', () => {
    const text = "Hello\n\nReply body.\n\n> quoted answer\n\n> more quoting\n";
    expect(splitQuotedMailText(text)).toEqual({ body: "Hello\n\nReply body.", quote: "> quoted answer\n\n> more quoting" });
  });

  it("splits at a classic separator header even without > prefixes", () => {
    const text = "收到。\n\n-----原始邮件-----\n发件人: Someone\n正文被旧客户端复制下来";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("收到。");
    expect(parts.quote).toContain("-----原始邮件-----");
    expect(parts.quote).toContain("正文被旧客户端复制下来");
  });

  it("supports the English original-message separator", () => {
    const text = "Got it.\n\n----- Original Message -----\nFrom: Someone\nforwarded body";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("Got it.");
    expect(parts.quote).toContain("forwarded body");
  });

  it("leaves interleaved replies inline and only folds the trailing quote", () => {
    const text = "answer one\n\n> old quote\n\nanswer two\n\n> newer quote";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("answer one\n\n> old quote\n\nanswer two");
    expect(parts.quote).toBe("> newer quote");
  });

  it("never folds when the whole message is a quote", () => {
    const text = "> all quoted";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });

  it("returns plain text unchanged when there is no quote", () => {
    const text = "Hello\n\nNothing quoted here.";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });
});

/** Re-assembles the parts the way the reader concatenates them. */
function joined(parts: ReturnType<typeof splitBodyLinks>): string {
  return parts.map((part) => part.text).join("");
}

function links(parts: ReturnType<typeof splitBodyLinks>): string[] {
  return parts.flatMap((part) => part.kind === "link" && part.href ? [part.href] : []);
}

describe("splitBodyLinks", () => {
  it("linkifies a bare URL and keeps the sentence around it as text", () => {
    const parts = splitBodyLinks("Fix available: https://github.com/o/r/pull/42");
    expect(parts).toEqual([
      { kind: "text", text: "Fix available: " },
      { kind: "link", text: "https://github.com/o/r/pull/42", href: "https://github.com/o/r/pull/42" },
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(links(splitBodyLinks("See https://example.com/a."))).toEqual(["https://example.com/a"]);
    expect(joined(splitBodyLinks("See https://example.com/a."))).toBe("See https://example.com/a.");
    for (const tail of [",", ";", ":", ")", "]", "\"", "'", "!", "?"]) {
      expect(links(splitBodyLinks(`ref https://example.com/a${tail}`)), tail).toEqual(["https://example.com/a"]);
    }
  });

  it("keeps a bracket the URL itself opened", () => {
    expect(links(splitBodyLinks("see https://en.example.org/wiki/Foo_(bar) end"))).toEqual(["https://en.example.org/wiki/Foo_(bar)"]);
    expect(links(splitBodyLinks("https://example.com/a)"))).toEqual(["https://example.com/a"]);
    expect(links(splitBodyLinks("https://example.com/a#frag)"))).toEqual(["https://example.com/a#frag"]);
  });

  it("handles the angle-bracket form without losing the brackets", () => {
    const parts = splitBodyLinks("mirror: <https://example.com/m>");
    expect(links(parts)).toEqual(["https://example.com/m"]);
    expect(joined(parts)).toBe("mirror: <https://example.com/m>");
    expect(parts[0].text.endsWith("<")).toBe(true);
    expect(parts[parts.length - 1].text.startsWith(">")).toBe(true);
  });

  it("linkifies several URLs on one line", () => {
    const parts = splitBodyLinks("a https://one.example/x b https://two.example/y?z=1 c");
    expect(links(parts)).toEqual(["https://one.example/x", "https://two.example/y?z=1"]);
    expect(joined(parts)).toBe("a https://one.example/x b https://two.example/y?z=1 c");
  });

  it("stops the link at Chinese text and full-width punctuation", () => {
    const parts = splitBodyLinks("已合并 https://github.com/o/r/pull/12 的依赖升级，请查看。");
    expect(links(parts)).toEqual(["https://github.com/o/r/pull/12"]);
    expect(joined(parts)).toBe("已合并 https://github.com/o/r/pull/12 的依赖升级，请查看。");
    expect(joined(splitBodyLinks("链接（https://example.com/x）"))).toBe("链接（https://example.com/x）");
    expect(links(splitBodyLinks("链接（https://example.com/x）"))).toEqual(["https://example.com/x"]);
  });

  it("does not linkify a URL that is the tail of a longer word", () => {
    expect(links(splitBodyLinks("see xhttps://example.com/a"))).toEqual([]);
  });

  it("refuses every scheme that is not http or https", () => {
    for (const body of [
      "javascript:alert(1)",
      "JavaScript:alert(document.domain)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "mailto:a@example.com",
      "ftp://example.com/x",
      "vbscript:msgbox(1)",
    ]) {
      expect(links(splitBodyLinks(body)), body).toEqual([]);
      expect(joined(splitBodyLinks(body)), body).toBe(body);
    }
  });

  it("keeps an executable scheme as prose even when a real link follows it", () => {
    const body = "javascript:alert(1) then https://example.com/a";
    expect(links(splitBodyLinks(body))).toEqual(["https://example.com/a"]);
    expect(joined(splitBodyLinks(body))).toBe(body);
  });

  it("returns text without links as a single untouched part", () => {
    expect(splitBodyLinks("没有链接的正文。")).toEqual([{ kind: "text", text: "没有链接的正文。" }]);
    expect(splitBodyLinks("")).toEqual([]);
  });

  it("preserves every character — newlines, blank lines, tabs and runs of spaces", () => {
    const body = "第一段\n\n第二段\t带制表符  和   连续空格\n\n    https://example.com/a\n\n尾部  \n";
    const parts = splitBodyLinks(body);
    expect(parts).toEqual([
      { kind: "text", text: "第一段\n\n第二段\t带制表符  和   连续空格\n\n    " },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: "\n\n尾部  \n" },
    ]);
    expect(joined(parts)).toBe(body);
  });

  it("preserves a CRLF body verbatim", () => {
    const body = "line one\r\n\r\nhttps://example.com/a\r\n";
    const parts = splitBodyLinks(body);
    expect(parts.filter((part) => part.kind === "text").map((part) => part.text).join("")).toBe("line one\r\n\r\n\r\n");
    expect(joined(parts)).toBe(body);
  });

  it("is idempotent: the same input yields the same parts, and prose stays prose", () => {
    const body = "已发布 https://example.com/a 详情，文档 https://example.com/docs。\n\n— Sent";
    const first = splitBodyLinks(body);
    expect(splitBodyLinks(joined(first))).toEqual(first);
    for (const part of first.filter((candidate) => candidate.kind === "text")) {
      expect(splitBodyLinks(part.text)).toEqual([{ kind: "text", text: part.text }]);
    }
  });

  it("does not linkify a bare scheme with no authority", () => {
    expect(links(splitBodyLinks("broken https:// and more"))).toEqual([]);
    expect(joined(splitBodyLinks("broken https:// and more"))).toBe("broken https:// and more");
  });
});

describe("sanitizeMailHtml", () => {
  it("keeps inline SVG but strips its event handlers", () => {
    const clean = sanitizeMailHtml('<p>before</p><svg width="10" height="10"><circle cx="5" cy="5" r="4" onload="alert(1)"/></svg><p>after</p>', false);

    expect(clean).toContain("<svg");
    expect(clean).not.toContain("onload");
    // Surrounding HTML is untouched.
    expect(clean).toContain("<p>before</p>");
    expect(clean).toContain("<p>after</p>");
  });

  it("keeps the visible text an SVG subtree renders, not just the element", () => {
    // Dropping the SVG element also drops its text nodes, so a mail whose
    // content is an inline SVG used to render as a blank block. That is a
    // real, visible loss — the subtree's text is content, not decoration.
    const clean = sanitizeMailHtml('<p>before</p><svg width="100" height="20"><text y="15">Click here to verify</text></svg><p>after</p>', false);

    expect(clean).toContain("Click here to verify");
    expect(clean).toContain("<svg");
    expect(clean).toContain("<p>before</p>");
    expect(clean).toContain("<p>after</p>");
  });

  it("keeps an <a target> so external mail links do not replace the reader tab", () => {
    // USE_PROFILES overwrites ALLOWED_ATTR and the html profile's table has no
    // "target", so without ADD_ATTR the attribute is silently dropped and every
    // _blank link in every mail degrades to a same-tab navigation.
    const clean = sanitizeMailHtml('<a href="https://example.com/x" target="_blank">Open</a>', false);

    expect(clean).toContain('href="https://example.com/x"');
    expect(clean).toContain('target="_blank"');
  });

  it("still strips every on* handler on an SVG link", () => {
    const clean = sanitizeMailHtml('<svg><a href="https://ok.example" onfocus="alert(1)" onload="alert(2)"><text>x</text></a></svg>', false);

    expect(clean).not.toContain("onfocus");
    expect(clean).not.toContain("onload");
    expect(clean).toContain('href="https://ok.example"');
  });

  it("drops SVG payload smuggled inside an HTML attribute context", () => {
    const clean = sanitizeMailHtml('<div><svg><foreignObject><iframe src="https://evil.example/x"></iframe></foreignObject></svg></div>', false);

    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("<iframe");
  });

  it("drops MathML, including the annotation-xml mXSS integration point", () => {
    const clean = sanitizeMailHtml('<p>x</p><math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>', false);

    expect(clean).not.toContain("<math");
    expect(clean).not.toContain("<mtext");
    expect(clean).not.toContain("<mglyph");
    expect(clean).not.toContain("onerror");
  });

  it("strips every on* event handler attribute", () => {
    const clean = sanitizeMailHtml('<div onclick="alert(1)" onmouseover="alert(2)"><img src="https://example.com/a.png" onerror="alert(3)"></div>', false);

    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("onmouseover");
    expect(clean).not.toContain("onerror");
    expect(clean).toContain("<div>");
    // Sanitization is not the layer that proxies images, so the bare URL is
    // still here. What must never reach the reader is that URL — assert on the
    // composed pipeline the reader actually renders.
    const readerHtml = rewriteRemoteImagesToProxy(clean);
    expect(readerHtml).not.toContain('src="https://example.com/a.png"');
    expect(readerHtml).toContain(`src="${proxyUrl("https://example.com/a.png")}"`);
  });

  it("strips javascript: and vbscript: URIs while keeping real links and CID images", () => {
    const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<a href="javascript:alert(1)">bad</a><a href="vbscript:msgbox(1)">worse</a><a href="https://example.com/ok">good</a><img src="cid:logo@mail"><img src="https://example.com/a.png">',
      false,
    ));

    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("vbscript:");
    // An <a href> is the reader's own click to make, so an https target stays.
    expect(clean).toContain('href="https://example.com/ok"');
    // Inline images are rewritten server-side to a cached URL, but a not-yet
    // resolved cid: must survive sanitization — the URI scheme is allow-listed,
    // and the proxy rewrite must not touch it either.
    expect(clean).toContain('src="cid:logo@mail"');
    // A remote img src, by contrast, is proxied: the bare URL does not survive.
    expect(clean).not.toContain('src="https://example.com/a.png"');
    expect(clean).toContain(`src="${proxyUrl("https://example.com/a.png")}"`);
  });

  it("keeps data: URIs on img, the channel inline and BIMI images legitimately use", () => {
    // Deliberate boundary: DOMPurify lists img among DEFAULT_DATA_URI_TAGS, so a
    // data: URL on an <img src> survives — inline mail images depend on it. The
    // payload is base64, so it stays an opaque attribute value and never becomes
    // a live SVG element in the reader.
    const clean = sanitizeMailHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="logo">', false);

    expect(clean).toContain('src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="');
    // The markup around it is HTML, not SVG: no element from the payload is parsed.
    expect(clean).not.toContain("<svg");
  });

  it("removes style, script, iframe, object, embed, and form elements", () => {
    const clean = sanitizeMailHtml(
      '<style>p{color:red}</style><script>alert(1)</script><iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf"><form action="https://evil.example"><input name="a"></form><p>kept</p>',
      false,
    );

    expect(clean).not.toContain("<style");
    expect(clean).not.toContain("color:red");
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("<object");
    expect(clean).not.toContain("<embed");
    expect(clean).not.toContain("<form");
    // The form element is gone even though KEEP_CONTENT keeps its children — with
    // no form ancestor an <input> has nothing to submit to.
    expect(clean).toContain("<p>kept</p>");
  });

  it("keeps the table layout and legacy presentational attributes mail depends on", () => {
    const html = '<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" align="center">'
      + '<tbody><tr><td valign="top" style="background-color:#ffffff;color:#333333">'
      + '<center><font face="Arial" size="3"><strong>Bold</strong> <em>italic</em></font></center>'
      + '<h1>Head</h1><ul><li>one</li></ul><ol><li>two</li></ol>'
      + '<blockquote>quoted</blockquote><pre><code>code()</code></pre><hr></td></tr></tbody></table>';
    const clean = sanitizeMailHtml(html, false);

    for (const fragment of [
      "<table", 'width="600"', 'cellpadding="0"', 'cellspacing="0"', 'bgcolor="#ffffff"', 'align="center"',
      "<tbody>", "<tr>", "<td", 'valign="top"', 'background-color:#ffffff', "color:#333333",
      "<center>", '<font face="Arial" size="3">', "<strong>", "<em>", "<h1>", "<ul>", "<li>",
      "<ol>", "<blockquote>", "<pre>", "<code>", "<hr>",
    ]) {
      expect(clean, fragment).toContain(fragment);
    }
  });

  it("still tags surfaces so the dark-mode contrast pass can see them", () => {
    const clean = sanitizeMailHtml('<div style="background:#171719"><p style="color:#f5f5f6">dark block</p></div><table bgcolor="#ffffff"><tr><td>light cell</td></tr></table>', true);

    expect(clean).toContain('data-nami-mail-surface="dark"');
    expect(clean).toContain('data-nami-mail-surface="light"');
    // A readable foreground is left alone...
    expect(clean).toContain("color:#f5f5f6");
    // ...while an unreadable one is still corrected after sanitization.
    const fixed = sanitizeMailHtml('<div style="background:#171719;color:#111111">mystery</div>', true);
    expect(fixed).not.toContain("color:#111111");
  });
});

describe("adversarial SVG and MathML", () => {
  // The svg profile is enabled so an inline SVG keeps its visible text (dropping
  // the element drops the subtree's text with it). That is only sound while the
  // dangerous parts are gone, so each sample below pairs the payload with the
  // marker that must NOT survive it. DOMPurify's own svg allow-list excludes
  // script/use/animate/set/foreignObject (svgDisallowed in purify.js); the three
  // animation elements it does allow are covered by FORBID_TAGS, because
  // `attributeName="HREF"` in uppercase evades purify.js:2213's href check.
  const cases: { name: string; html: string; forbidden: RegExp }[] = [
    { name: "inline svg onload handler", html: '<svg><circle r="4" onload="alert(1)"/></svg>', forbidden: /onload/i },
    { name: "svg script element", html: '<svg><script>alert(1)</script></svg>', forbidden: /<script/i },
    { name: "svg script in CDATA", html: '<svg><script><![CDATA[alert(1)]]></script></svg>', forbidden: /<script/i },
    { name: "nested svg script", html: '<svg><svg><script>alert(1)</script></svg></svg>', forbidden: /<script/i },
    { name: "use pulling a data: payload", html: '<svg><use xlink:href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/></svg>', forbidden: /<use[\s>]/i },
    { name: "use pointing at an external file", html: '<svg><use href="https://evil.example/x.svg#a"/></svg>', forbidden: /<use[\s>]/i },
    { name: "animate rewriting href", html: '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>', forbidden: /<animate[\s>]|javascript:/i },
    { name: "set rewriting href", html: '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>', forbidden: /<set[\s>]|javascript:/i },
    { name: "animateColor with uppercase HREF", html: '<svg><a><animateColor attributeName="HREF" values="//evil.example" begin="0s"/></a></svg>', forbidden: /animateColor|attributeName/i },
    { name: "animateTransform with uppercase HREF", html: '<svg><a><animateTransform attributeName="HREF" to="//evil.example"/></a></svg>', forbidden: /animateTransform|attributeName/i },
    { name: "animateMotion with uppercase HREF", html: '<svg><a><animateMotion attributeName="HREF" to="//evil.example"/></a></svg>', forbidden: /animateMotion|attributeName/i },
    { name: "foreignObject wrapping an iframe", html: '<svg><foreignObject><iframe src="https://evil.example/x"></iframe></foreignObject></svg>', forbidden: /foreignObject|<iframe/i },
    { name: "foreignObject wrapping loose markup", html: '<svg><foreignObject><body><img src=x onerror=alert(1)></body></foreignObject></svg>', forbidden: /foreignObject|onerror/i },
    { name: "svg style element with an @import", html: '<svg><style>@import url(https://evil.example/x.css);</style></svg>', forbidden: /<style|@import/i },
    { name: "svg a with a javascript: xlink:href", html: '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', forbidden: /javascript:/i },
    { name: "svg a with a javascript: href", html: '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>', forbidden: /javascript:/i },
    { name: "math mglyph mXSS integration point", html: '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>', forbidden: /<math|<mtext|<mglyph|onerror/i },
    { name: "math maction statusline", html: '<math><maction actiontype="statusline#http://evil" xlink:href="javascript:alert(1)">click</maction></math>', forbidden: /<math|<maction|javascript:/i },
    { name: "math annotation-xml html integration point", html: '<math><semantics><annotation-xml encoding="text/html"><iframe src="javascript:alert(1)"></iframe></annotation-xml></semantics></math>', forbidden: /<math|annotation-xml|<iframe/i },
    { name: "form wrapped math mglyph", html: '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>', forbidden: /<math|<mglyph|onerror/i },
  ];

  for (const { name, html, forbidden } of cases) {
    it(`strips ${name}`, () => {
      expect(sanitizeMailHtml(html, false)).not.toMatch(forbidden);
    });
  }

  it("does not let a payload come back after the reader's own re-parses", () => {
    // sanitizeMailHtml is followed by more parse-serialize passes (the surface
    // walk returns template.innerHTML, and the quote fold re-parses it), which
    // is where namespace-confusion payloads traditionally mutate back to life.
    // Re-parsing each sanitized sample must not resurrect a live handler.
    for (const { name, html } of cases) {
      let current = sanitizeMailHtml(html, false);
      for (let pass = 0; pass < 3; pass += 1) {
        const template = document.createElement("template");
        template.innerHTML = current;
        current = template.innerHTML;
      }
      const template = document.createElement("template");
      template.innerHTML = current;
      for (const element of template.content.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          expect(attribute.name.toLowerCase(), `${name}: ${attribute.name}`).not.toMatch(/^on/);
          if (["href", "xlink:href", "src"].includes(attribute.name.toLowerCase())) {
            expect(attribute.value.replace(/\s/g, "").toLowerCase(), `${name}: ${attribute.name}`).not.toMatch(/^(javascript|vbscript):/);
          }
        }
      }
    }
  });

  it("keeps the mail layout the reader depends on while SVG stays enabled", () => {
    // The point of enabling svg is to preserve content, so the ordinary mail
    // table must be exactly as intact as before.
    const clean = sanitizeMailHtml(
      '<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" align="center">'
      + '<tbody><tr><td valign="top" style="background-color:#ffffff;color:#333333">'
      + '<center><font face="Arial" size="3"><strong>Bold</strong></font></center></td></tr></tbody></table>',
      false,
    );

    for (const fragment of ["<table", 'width="600"', 'cellpadding="0"', 'bgcolor="#ffffff"', 'align="center"', "<tbody>", "<tr>", "<td", 'valign="top"', "<center>", '<font face="Arial" size="3">', "<strong>"]) {
      expect(clean, fragment).toContain(fragment);
    }
  });
});

describe("rewriteRemoteImagesToProxy", () => {
  it("routes every remote img src through the proxy, keeping the picture working", () => {
    const clean = rewriteRemoteImagesToProxy(
      '<p>Report</p><img src="https://evil.tld/pixel?u=victim" width="1" height="1">'
      + '<img src="http://cdn.example/banner.png"><img src="//tracker.example/p.png">',
    );

    expect(clean).toContain(`src="${proxyUrl("https://evil.tld/pixel?u=victim")}"`);
    expect(clean).toContain(`src="${proxyUrl("http://cdn.example/banner.png")}"`);
    // A protocol-relative URL must arrive at the proxy absolute — the server
    // has no document base to resolve "//tracker.example/p.png" against.
    expect(clean).toContain(`src="${proxyUrl("http://tracker.example/p.png")}"`);
    // Not one bare remote host is left for the renderer to contact directly.
    expect(clean).not.toMatch(/src="(https?:)?\/\//);
    // Layout attributes ride along untouched, or tracking-mail layouts shift.
    expect(clean).toContain('width="1"');
    expect(clean).toContain('height="1"');
    expect(clean).toContain("<p>Report</p>");
  });

  it("leaves data:, cid:, blob: and the server's inline URLs alone", () => {
    // None of these is a request to a third party, so proxying them would only
    // break inline images. cid: is rewritten server-side to the inline
    // endpoint, which is same-origin and must pass through untouched as well.
    const clean = rewriteRemoteImagesToProxy(
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="logo">'
      + '<img src="cid:logo@mail">'
      + '<img src="/api/messages/11111111-1111-1111-1111-111111111111/inline/p1">',
    );

    expect(clean).toContain('src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="');
    expect(clean).toContain('src="cid:logo@mail"');
    expect(clean).toContain('src="/api/messages/11111111-1111-1111-1111-111111111111/inline/p1"');
    expect(clean).not.toContain("/api/images/proxy");
  });

  it("rewrites srcset, which would otherwise bypass a src-only fix entirely", () => {
    // The browser prefers srcset candidates whenever srcset is present and never
    // requests src at all, so leaving this attribute alone reopens the whole
    // leak behind a correctly proxied src.
    const clean = rewriteRemoteImagesToProxy(
      '<img src="https://cdn.example/hero.png" srcset="https://evil.tld/pixel 1x, https://evil.tld/pixel@2x 2x">',
    );

    expect(clean).toContain(`srcset="${proxyUrl("https://evil.tld/pixel")} 1x, ${proxyUrl("https://evil.tld/pixel@2x")} 2x"`);
    expect(clean).not.toContain("evil.tld/pixel 1x");
  });

  it("keeps same-origin srcset candidates while proxying the remote ones", () => {
    const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<img srcset="/api/messages/1/inline/p1 1x, https://evil.tld/pixel 2x">',
      false,
    ));

    // Walk the composed chain, not rewriteRemoteImagesToProxy alone: this
    // attribute is DOMPurify's to keep or drop, and a rewrite-only assertion
    // cannot see that. See the next test for what DOMPurify actually does to a
    // data: candidate.
    expect(clean).toContain('srcset="/api/messages/1/inline/p1 1x, '
      + `${proxyUrl("https://evil.tld/pixel")} 2x"`);
    expect(clean).not.toContain("evil.tld/pixel 2x");
  });

  it("drops a srcset candidate that carries data:, losing the whole attribute", () => {
    // Documented, measured DOMPurify behaviour — NOT a leak, and NOT introduced
    // by the proxy pass. DOMPurify validates srcset candidates against its URI
    // allow-list and, on any candidate it rejects, drops the entire attribute
    // rather than the single candidate. So a mail whose srcset mixes an inline
    // data: candidate with anything else loses its responsive candidates and
    // falls back to src.
    //
    // The previous version of this test asserted the opposite ("keeps data: and
    // same-origin srcset candidates") while calling rewriteRemoteImagesToProxy
    // directly. That passed, and was worthless: it described a string the reader
    // never renders. Whether it is safe here is decided by DOMPurify, so the
    // assertion has to run DOMPurify too.
    const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<img srcset="data:image/png;base64,AAA= 1x, /api/messages/1/inline/p1 2x">',
      false,
    ));

    expect(clean).toBe("<img>");
    expect(clean).not.toContain("srcset");
    expect(clean).not.toContain("data:image/png");
  });

  it("never lets a remote host reach the reader through a srcset on any element", () => {
    // srcset beats src whenever it is present, so a same-origin or cid: src
    // alongside a remote srcset buys nothing: the browser never requests src.
    // Every element that honours srcset has to be rewritten.
    const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<picture><source srcset="https://evil.tld/q.gif 2x"><img src="cid:x"></picture>'
      + '<video><source srcset="https://evil.tld/r.gif 1x"></video>'
      + '<input type="image" src="cid:y" srcset="https://evil.tld/s.gif 3x">',
      false,
    ));

    // Assert on the attribute *value*, not the whole string: the proxied URL
    // percent-encodes the host inside url=, so a bare host search would match
    // the very output that proves the rewrite worked.
    expect(clean).not.toMatch(/srcset="https?:/);
    expect(clean).not.toMatch(/srcset="\/\//);
    expect(clean).toContain(`srcset="${proxyUrl("https://evil.tld/q.gif")} 2x"`);
    expect(clean).toContain(`srcset="${proxyUrl("https://evil.tld/r.gif")} 1x"`);
    expect(clean).toContain(`srcset="${proxyUrl("https://evil.tld/s.gif")} 3x"`);
    // The cid: siblings are untouched — they are inline content, not a fetch.
    expect(clean).toContain('src="cid:x"');
    expect(clean).toContain('src="cid:y"');
  });

  it("removes the tracking pixel from the elements that survive the sanitizer", () => {
    // Each of these was measured leaking through the full chain before the
    // rewrite covered more than img[src]/SVG image: DOMPurify's html profile
    // keeps all of them, so the reader really did request these URLs.
    const vectors: { name: string; html: string; remote: string; proxied: string }[] = [
      { name: "video poster", html: '<video poster="https://evil.tld/p.gif"></video>', remote: "https://evil.tld/p.gif", proxied: "poster" },
      { name: "video src", html: '<video src="https://evil.tld/v.mp4"></video>', remote: "https://evil.tld/v.mp4", proxied: "src" },
      { name: "audio src", html: '<audio src="https://evil.tld/a.mp3" controls></audio>', remote: "https://evil.tld/a.mp3", proxied: "src" },
      { name: "track src", html: '<video><track src="https://evil.tld/c.vtt"></video>', remote: "https://evil.tld/c.vtt", proxied: "src" },
      { name: "source src", html: '<video><source src="https://evil.tld/s.mp4"></video>', remote: "https://evil.tld/s.mp4", proxied: "src" },
      { name: "input type=image src", html: '<input type="image" src="https://evil.tld/r.gif">', remote: "https://evil.tld/r.gif", proxied: "src" },
    ];

    for (const vector of vectors) {
      const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(vector.html, false));
      expect(clean, vector.name).not.toMatch(/(src|poster)="https?:\/\/evil\.tld/);
      expect(clean, vector.name).toContain(`${vector.proxied}="${proxyUrl(vector.remote)}"`);
    }
  });

  it("matches input[type=image] case-insensitively, as the browser does", () => {
    // The HTML parser lowercases attribute NAMES but not values, and the image
    // button state is decided by an ASCII-case-insensitive comparison — so
    // type="IMAGE" is still an image button to the renderer. A case-sensitive
    // selector here would leave the whole vector open.
    const clean = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<input type="IMAGE" src="https://evil.tld/u.gif">',
      false,
    ));

    expect(clean).not.toContain('src="https://evil.tld/u.gif"');
    expect(clean).toContain(`src="${proxyUrl("https://evil.tld/u.gif")}"`);
  });

  it("covers the other attributes a mail body can hide a pixel behind", () => {
    const clean = rewriteRemoteImagesToProxy(
      '<table background="https://evil.tld/bg.png"><tr><td>x</td></tr></table>'
      + '<div style="background-image:url(https://evil.tld/css.png)">y</div>'
      + '<svg><image href="https://evil.tld/svg1.png"/><image xlink:href="https://evil.tld/svg2.png"/></svg>',
    );

    expect(clean).toContain(`background="${proxyUrl("https://evil.tld/bg.png")}"`);
    // The double quotes go through attribute serialization as &quot;, which the
    // parser turns back into real quotes — assert on the decoded value, and on
    // the fact that the browser still resolves it as a real CSS url().
    const parsed = document.createElement("template");
    parsed.innerHTML = clean;
    const styled = parsed.content.querySelector("div")!;
    expect(styled.style.backgroundImage).toContain(proxyUrl("https://evil.tld/css.png"));
    expect(clean).toContain(`href="${proxyUrl("https://evil.tld/svg1.png")}"`);
    expect(clean).toContain(`xlink:href="${proxyUrl("https://evil.tld/svg2.png")}"`);
    expect(clean).not.toMatch(/(background|href)="https:\/\/evil\.tld/);
  });

  it("leaves a non-URL background attribute and a data: url() untouched", () => {
    // background is overloaded: the overwhelmingly common value is a colour,
    // and a data: url() is inline content, not a third-party fetch.
    const clean = rewriteRemoteImagesToProxy(
      '<table bgcolor="#ffffff"><tr><td background="#f5f5f6">a</td></tr></table>'
      + '<div style="background-image:url(data:image/png;base64,AAA=)">b</div>',
    );

    expect(clean).toContain('background="#f5f5f6"');
    expect(clean).toContain("url(data:image/png;base64,AAA=)");
    expect(clean).not.toContain("/api/images/proxy");
  });

  it("is idempotent, so a body can pass through it more than once", () => {
    // The translation pipeline re-runs the body through its own parse-serialize
    // passes, and the reader already-proxied URLs resolve same-origin. Applying
    // it twice must not produce /api/images/proxy?url=/api/images/proxy...
    const once = rewriteRemoteImagesToProxy('<img src="https://evil.tld/p.png">');
    expect(rewriteRemoteImagesToProxy(once)).toBe(once);
  });

  it("never touches an <a href>: a link is the reader's own click to make", () => {
    const clean = rewriteRemoteImagesToProxy(
      '<a href="https://example.com/x">Open</a><img src="https://evil.tld/p.png">',
    );

    expect(clean).toContain('href="https://example.com/x"');
    expect(clean).toContain(`src="${proxyUrl("https://evil.tld/p.png")}"`);
  });

  it("returns the input unchanged when there is nothing to rewrite", () => {
    expect(rewriteRemoteImagesToProxy("")).toBe("");
    expect(rewriteRemoteImagesToProxy("<p>plain text body</p>")).toBe("<p>plain text body</p>");
  });

  it("removes the tracking pixel even when it is hidden by a table layout", () => {
    // The canonical open-time/read-receipt beacon, including the presentation
    // attributes real beacon mail uses to stay invisible.
    const readerHtml = rewriteRemoteImagesToProxy(sanitizeMailHtml(
      '<table role="presentation" width="0" cellspacing="0" cellpadding="0" border="0">'
      + '<tr><td height="0" style="height:0;line-height:0;font-size:0;">'
      + '<img src="https://evil.tld/open?uid=42" width="1" height="1" alt="" style="display:none;border:0" border="0">'
      + '</td></tr></table><p>Real content</p>',
      false,
    ));

    // The host survives only percent-encoded inside the proxy's url= parameter —
    // no attribute points the renderer at it any more.
    expect(readerHtml).not.toMatch(/(src|href|background)="(https?:)?\/\/evil\.tld/);
    expect(readerHtml).toContain(proxyUrl("https://evil.tld/open?uid=42"));
    expect(readerHtml).toContain("<p>Real content</p>");
  });
});
