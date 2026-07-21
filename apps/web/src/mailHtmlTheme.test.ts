import { describe, expect, it } from "vitest";
import { colorLuminance, mailBackgroundColor, mailReaderSurface, mailSurfaceForBackground, shouldResetMailForeground } from "./mailHtmlTheme";

describe("mail HTML theme normalization", () => {
  it("recognizes explicit light and dark email surfaces", () => {
    expect(mailSurfaceForBackground("#ffffff")).toMatchObject({ tone: "light" });
    expect(mailSurfaceForBackground("rgb(18, 18, 20)")).toMatchObject({ tone: "dark" });
    expect(mailSurfaceForBackground("transparent")).toBeNull();
    expect(mailSurfaceForBackground("rgba(255, 255, 255, 0)")).toBeNull();
    expect(mailSurfaceForBackground("rgba(255, 255, 255, .5)")).toBeNull();
  });

  it("parses modern and legacy color syntax without treating transparent fills as solid", () => {
    expect(colorLuminance("hsl(0 100% 50%)")).toBeCloseTo(0.2126, 4);
    expect(colorLuminance("rgb(100% 100% 100% / 50%)")).toBeCloseTo(1, 4);
    expect(mailSurfaceForBackground("rgb(255 255 255 / 95%)")).toMatchObject({ tone: "light" });
    expect(mailSurfaceForBackground("rgb(255 255 255 / 50%)")).toBeNull();
    expect(mailSurfaceForBackground("#fff8")).toBeNull();
    expect(mailSurfaceForBackground("#ffff")).toMatchObject({ tone: "light" });
  });

  it("reads CSS background, background-color, and legacy bgcolor values", () => {
    expect(mailBackgroundColor("#ffffff", null, null)).toBe("#ffffff");
    expect(mailBackgroundColor(null, "center / cover no-repeat #171719", null)).toBe("#171719");
    expect(mailBackgroundColor(null, null, "#ffffff")).toBe("#ffffff");
    expect(mailBackgroundColor(null, "url('newsletter.png') #ffffff", null)).toBe("#ffffff");
    expect(mailBackgroundColor(null, "linear-gradient(#ffffff, #171719)", null)).toBeNull();
    expect(mailBackgroundColor("#ffffff", "#171719", "#000000")).toBe("#ffffff");
  });

  it("resets a nearly white foreground on a white email surface", () => {
    const whiteSurface = mailSurfaceForBackground("#ffffff");

    expect(whiteSurface).not.toBeNull();
    expect(shouldResetMailForeground("#f3f3f3", whiteSurface)).toBe(true);
    expect(shouldResetMailForeground("#888888", whiteSurface)).toBe(true);
    expect(shouldResetMailForeground("#202124", whiteSurface)).toBe(false);
  });

  it("catches a white legacy table with white font or WebKit text-fill copy", () => {
    const tableSurface = mailSurfaceForBackground(mailBackgroundColor(null, null, "#f7f7f7"));

    expect(tableSurface).toMatchObject({ tone: "light" });
    expect(shouldResetMailForeground("#ffffff", tableSurface)).toBe(true);
    expect(shouldResetMailForeground("rgb(255 255 255 / 88%)", tableSurface)).toBe(true);
  });

  it("keeps readable CTA text while correcting collapsed contrast on dark surfaces", () => {
    const darkSurface = mailSurfaceForBackground("#171719");

    expect(darkSurface).not.toBeNull();
    expect(shouldResetMailForeground("#161616", darkSurface)).toBe(true);
    expect(shouldResetMailForeground("#f5f5f6", darkSurface)).toBe(false);
  });

  it("keeps an identifiable branded link color while still removing invisible link text", () => {
    const whiteSurface = mailSurfaceForBackground("#ffffff");

    expect(whiteSurface).not.toBeNull();
    expect(shouldResetMailForeground("#4285f4", whiteSurface, 3)).toBe(false);
    expect(shouldResetMailForeground("#aaaaaa", whiteSurface, 3)).toBe(true);
  });

  it("uses the dark reader as the fallback when email markup has no known surface", () => {
    expect(shouldResetMailForeground("#111111", null)).toBe(true);
    expect(shouldResetMailForeground("#f5f5f6", null)).toBe(false);
  });

  it("uses the active reader surface for inherited text in either app theme", () => {
    const lightReader = mailReaderSurface("light");
    const darkReader = mailReaderSurface("dark");

    expect(shouldResetMailForeground("#f5f5f6", lightReader)).toBe(true);
    expect(shouldResetMailForeground("#151517", lightReader)).toBe(false);
    expect(shouldResetMailForeground("#151517", darkReader)).toBe(true);
    expect(shouldResetMailForeground("#f5f5f6", darkReader)).toBe(false);
  });

  it("corrects a translucent foreground only when its rendered contrast collapses", () => {
    const darkReader = mailReaderSurface("dark");

    expect(shouldResetMailForeground("rgb(255 255 255 / 10%)", darkReader)).toBe(true);
    expect(shouldResetMailForeground("rgb(255 255 255 / 50%)", darkReader)).toBe(false);
  });
});
