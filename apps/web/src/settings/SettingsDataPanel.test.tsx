// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDataPanel from "./SettingsDataPanel";
import { I18nProvider } from "../i18n";
import { request } from "../api";
import { activateApplicationBackup, previewApplicationBackup } from "../dataRecoveryApi";
vi.mock("../api", () => ({ request: vi.fn() }));
vi.mock("../dataRecoveryApi", () => ({ activateApplicationBackup: vi.fn(), previewApplicationBackup: vi.fn(), exportApplicationBackup: vi.fn() }));
describe("Data and privacy controls", () => {
  let container: HTMLDivElement; let root: Root;
  const button = (text: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text)!;
  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(request).mockResolvedValue({ mode: "block", trustedSenders: ["ada@example.test"] });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(<I18nProvider><SettingsDataPanel /></I18nProvider>); });
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.querySelectorAll(".settings-data-dialog-backdrop").forEach((node) => node.remove()); });
  it("requires a validated preview and explicit confirmation before activation", async () => {
    vi.mocked(previewApplicationBackup).mockResolvedValue({ id: "preview", createdAt: "2026-11-07T00:00:00Z", schemaVersion: 5, counts: { messages: 1 }, files: 1, bytes: 4096 });
    vi.mocked(activateApplicationBackup).mockResolvedValue({ ok: true });
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-backup-restore")!.click(); });
    expect(document.getElementById("data-restore-title")).not.toBeNull();
    const password = document.querySelector<HTMLInputElement>('#restore-backup-password')!;
    const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "synthetic-password");
      password.dispatchEvent(new Event("input", { bubbles: true }));
      Object.defineProperty(file, "files", { value: [new File(["synthetic"], "fixture.namibak")], configurable: true });
      file.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { button("校验并预览").click(); });
    const activate = button("确认恢复并等待重启");
    expect(activate.disabled).toBe(true); expect(activateApplicationBackup).not.toHaveBeenCalled();
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(activate.disabled).toBe(false);
    await act(async () => { activate.click(); });
    expect(activateApplicationBackup).toHaveBeenCalledWith("preview");
    expect(container.textContent).toContain("请完全退出并重新打开");
  });
  it("persists removing a trusted sender and exposes no backup controls in demo mode", async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-trusted-senders")!.click(); });
    expect(document.getElementById("data-trusted-title")).not.toBeNull();
    const revoke = document.querySelector<HTMLButtonElement>('[aria-label="撤销对 ada@example.test 的信任"]')!;
    await act(async () => { revoke.click(); });
    expect(request).toHaveBeenCalledWith("/api/image-policy", { method: "PATCH", body: JSON.stringify({ mode: "block", trustedSenders: [] }) });
    await act(async () => { root.render(<I18nProvider><SettingsDataPanel demoMode /></I18nProvider>); });
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-backup-export")!.click(); });
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(true);
    await act(async () => { button("取消").click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-backup-restore")!.click(); });
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
  });
  it("keeps decision-relevant copy standing and folds the backup inventory into the header hint", async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-backup-export")!.click(); });
    const exportDialog = document.querySelector(".settings-data-dialog")!;
    const warnings = Array.from(exportDialog.querySelectorAll(".settings-data-note.is-warning")).map((node) => node.textContent ?? "").join("");
    expect(warnings).toContain("凭据");
    expect(warnings).toContain("永久无法打开");
    const hint = exportDialog.querySelector<HTMLElement>(".settings-data-dialog-head [data-tooltip]")!;
    expect(hint.getAttribute("data-tooltip")).toContain("未下载的收件附件");
    expect(exportDialog.textContent).toContain("3 GiB");
    await act(async () => { button("取消").click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("#data-backup-restore")!.click(); });
    const restoreDialog = document.querySelector(".settings-data-dialog")!;
    expect(restoreDialog.querySelector(".settings-data-note.is-warning")!.textContent).toContain("当前数据保留");
    expect(restoreDialog.querySelector(".settings-data-dialog-head [data-tooltip]")).toBeNull();
  });
});
