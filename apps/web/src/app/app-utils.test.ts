// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collapseQuotedMailHtml, sanitizeMailHtml, splitBodyLinks, splitQuotedMailText } from "./app-utils";

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
    expect(clean).toContain('src="https://example.com/a.png"');
  });

  it("strips javascript: and vbscript: URIs while keeping real links and CID images", () => {
    const clean = sanitizeMailHtml(
      '<a href="javascript:alert(1)">bad</a><a href="vbscript:msgbox(1)">worse</a><a href="https://example.com/ok">good</a><img src="cid:logo@mail"><img src="https://example.com/a.png">',
      false,
    );

    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("vbscript:");
    expect(clean).toContain('href="https://example.com/ok"');
    // Inline images are rewritten server-side to a cached URL, but a not-yet
    // resolved cid: must survive sanitization — the URI scheme is allow-listed.
    expect(clean).toContain('src="cid:logo@mail"');
    expect(clean).toContain('src="https://example.com/a.png"');
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
