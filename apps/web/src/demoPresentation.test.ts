import { describe, expect, it } from "vitest";
import { readDemoPresentation } from "./demoPresentation";

describe("public demo presentation", () => {
  it("requires both sample-data mode and the site preview opt-in", () => {
    for (const search of ["", "?preview=site&locale=en-US", "?demo=1", "?demo=0&preview=site"]) {
      expect(readDemoPresentation(search)).toBeNull();
    }
  });
  it("accepts the public language, theme and workspace choices", () => {
    expect(readDemoPresentation("?demo=1&preview=site&locale=en-US&theme=light&view=agent")).toEqual({
      locale: "en-US", theme: "light", view: "agent",
    });
  });
  it("falls back to known presentation values for unknown input", () => {
    expect(readDemoPresentation("?demo=1&preview=site&locale=other&theme=other&view=other")).toEqual({
      locale: "zh-CN", theme: "dark", view: "mail",
    });
  });
});
