import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import StartupUpdatePrompt, { startupUpdatePromptVersion } from "./StartupUpdatePrompt";
import type { DesktopUpdateSnapshot } from "./desktop";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const available: DesktopUpdateSnapshot = {
  schemaVersion: 2,
  phase: "available",
  currentVersion: "0.1.0",
  targetVersion: "0.1.1",
  percent: null,
  checkedAt: "2026-07-22T08:00:00.000Z",
  suppression: "none",
  remindAt: null,
  reason: "releaseAvailable",
  args: {},
};

function renderPrompt(snapshot: DesktopUpdateSnapshot): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <StartupUpdatePrompt snapshot={snapshot} onSnapshot={() => undefined} />
    </I18nProvider>,
  );
}

describe("startup update prompt", () => {
  it("opens only for an unsuppressed available or ready release, or an installed cleanup result", () => {
    expect(startupUpdatePromptVersion(available)).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "ready", percent: 100 })).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "downloading", percent: 42 })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, phase: "up-to-date" })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, phase: "error" })).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "error" }, false, "0.1.1")).toBeNull();
    const cleanupComplete = {
      ...available,
      phase: "up-to-date" as const,
      reason: "installResult" as const,
      args: { installStage: "cleanup" as const, cleanupComplete: true },
    };
    expect(startupUpdatePromptVersion(cleanupComplete)).toBe("0.1.1");
    expect(startupUpdatePromptVersion(cleanupComplete, false, "0.1.1")).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, phase: "error", targetVersion: null })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, suppression: "skipped" })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, suppression: "snoozed" })).toBeNull();
    expect(startupUpdatePromptVersion(available, true)).toBeNull();
  });

  it("uses an app-owned accessible dialog with explicit update, skip, and reminder actions", () => {
    const markup = renderPrompt(available);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain(zh("update.prompt.updateVersion"));
    expect(markup).toContain(zh("update.prompt.skipVersion"));
    expect(markup).toContain(zh("update.prompt.snooze.label"));
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain("<select");
  });

  it("keeps a background download non-modal while retaining an accessible progress status", () => {
    const markup = renderPrompt({ ...available, phase: "downloading", percent: 42 });

    expect(markup).toContain('class="update-background-status"');
    expect(markup).toContain(zh("update.prompt.background.description"));
    expect(markup).not.toContain('aria-modal="true"');
  });

  it("presents a recoverable previous-update failure without surfacing targetless network errors", () => {
    const failure = { ...available, phase: "error" as const, reason: "installerNotStarted" as const };
    const markup = renderPrompt(failure);

    expect(markup).toContain(zh("update.prompt.error.eyebrow"));
    expect(markup).toContain(zh("update.status.installerNotStarted"));
    expect(markup).toContain(zh("update.prompt.checkAgain"));
    expect(markup).toContain(zh("update.prompt.later"));
    expect(renderPrompt({ ...failure, targetVersion: null })).toBe("");
  });

  it("keeps successful cleanup separate from a recoverable cleanup retry", () => {
    for (const { cleanupComplete, phase } of [
      { cleanupComplete: false, phase: "error" as const },
      { cleanupComplete: true, phase: "up-to-date" as const },
    ]) {
      const markup = renderPrompt({
        ...available,
        phase,
        reason: "installResult",
        args: { installStage: "cleanup", cleanupComplete },
      });

      expect(markup).toContain(zh("update.prompt.complete.eyebrow"));
      expect(markup).toContain("v0.1.1 已安装");
      expect(markup).toContain(zh("update.prompt.complete.description"));
      expect(markup).toContain(zh(cleanupComplete ? "update.status.cleanupComplete" : "update.status.cleanupPending"));
      expect(markup).not.toContain("v0.1.1 未能完成安装");
      if (cleanupComplete) {
        expect(markup).not.toContain(zh("update.prompt.error.eyebrow"));
        expect(markup).toContain(zh("update.prompt.acknowledge"));
        expect(markup).not.toContain('role="alert"');
        expect(markup).not.toContain("update-prompt-icon error");
        expect(markup).not.toContain(`>${zh("update.prompt.checkAgain")}</button>`);
      } else {
        expect(markup).toContain('role="alert"');
        expect(markup).toContain("update-prompt-icon error");
        expect(markup).toContain(zh("update.prompt.checkAgain"));
        expect(markup).toContain(zh("update.prompt.later"));
        expect(markup).not.toContain(`>${zh("update.prompt.acknowledge")}</button>`);
      }
    }
  });
});
