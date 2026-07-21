import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StartupUpdatePrompt, { startupUpdatePromptVersion } from "./StartupUpdatePrompt";
import type { DesktopUpdateSnapshot } from "./desktop";

const available: DesktopUpdateSnapshot = {
  phase: "available",
  currentVersion: "0.1.0",
  targetVersion: "0.1.1",
  percent: null,
  checkedAt: "2026-07-22T08:00:00.000Z",
  suppression: "none",
  remindAt: null,
  message: "发现 v0.1.1。请选择下载、跳过此版本或稍后提醒。",
};

describe("startup update prompt", () => {
  it("opens only for an unsuppressed available or ready release", () => {
    expect(startupUpdatePromptVersion(available)).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "ready", percent: 100 })).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "downloading", percent: 42 })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, phase: "error" })).toBe("0.1.1");
    expect(startupUpdatePromptVersion({ ...available, phase: "error" }, false, "0.1.1")).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, phase: "error", targetVersion: null })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, suppression: "skipped" })).toBeNull();
    expect(startupUpdatePromptVersion({ ...available, suppression: "snoozed" })).toBeNull();
    expect(startupUpdatePromptVersion(available, true)).toBeNull();
  });

  it("uses an app-owned accessible dialog with explicit update, skip, and reminder actions", () => {
    const markup = renderToStaticMarkup(
      <StartupUpdatePrompt snapshot={available} onSnapshot={() => undefined} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("更新此版本");
    expect(markup).toContain("跳过此版本");
    expect(markup).toContain("稍后提醒");
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain("<select");
  });

  it("keeps a background download non-modal while retaining an accessible progress status", () => {
    const markup = renderToStaticMarkup(
      <StartupUpdatePrompt snapshot={{ ...available, phase: "downloading", percent: 42 }} onSnapshot={() => undefined} />,
    );

    expect(markup).toContain('class="update-background-status"');
    expect(markup).toContain("可继续处理邮件，完成后会再次提醒");
    expect(markup).not.toContain('aria-modal="true"');
  });

  it("presents a recoverable previous-update failure without surfacing targetless network errors", () => {
    const failure = { ...available, phase: "error" as const, message: "更新安装程序无法启动，应用仍可继续使用。" };
    const markup = renderToStaticMarkup(
      <StartupUpdatePrompt snapshot={failure} onSnapshot={() => undefined} />,
    );

    expect(markup).toContain("上次更新未完成");
    expect(markup).toContain("重新检查");
    expect(markup).toContain("稍后处理");
    expect(renderToStaticMarkup(
      <StartupUpdatePrompt snapshot={{ ...failure, targetVersion: null }} onSnapshot={() => undefined} />,
    )).toBe("");
  });

  it("does not describe an installed update as incomplete when only cleanup needs attention", () => {
    const cleanupMessages = [
      "v0.1.1 已安装，但临时更新文件未能完全清理。请在关闭其他 Nami Mail 进程后重新检查更新。",
      "v0.1.1 已安装，遗留的临时更新文件已在启动时清理。",
    ];

    for (const message of cleanupMessages) {
      const markup = renderToStaticMarkup(
        <StartupUpdatePrompt snapshot={{ ...available, phase: "error", message }} onSnapshot={() => undefined} />,
      );

      expect(markup).toContain("更新已完成");
      expect(markup).toContain("v0.1.1 已安装");
      expect(markup).toContain("更新已安装完成");
      expect(markup).not.toContain("上次更新未完成");
      expect(markup).not.toContain("v0.1.1 未能完成安装");
      expect(markup).toContain("知道了");
      expect(markup).not.toContain('role="alert"');
      expect(markup).not.toContain("update-prompt-icon error");
      expect(markup).not.toContain("重新检查");
    }
  });
});
