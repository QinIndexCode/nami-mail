import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerPresets } from "../src/providers.js";

const { ImapFlow, createTransport } = vi.hoisted(() => ({
  ImapFlow: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("imapflow", () => ({ ImapFlow }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { testAccountConnection } from "../src/mail.js";

const qqProvider = providerPresets.find((preset) => preset.id === "qq");
if (!qqProvider) throw new Error("qq provider preset missing");

const password = "sixteen-char-code";

describe("password account transport verification", () => {
  const imap = {
    usable: true,
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [{ path: "INBOX" }, { path: "Sent" }, { path: "Trash" }]),
    logout: vi.fn(async () => undefined),
  };
  const smtp = {
    verify: vi.fn(async () => true),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imap.usable = true;
    imap.connect.mockResolvedValue(undefined);
    imap.list.mockResolvedValue([{ path: "INBOX" }, { path: "Sent" }, { path: "Trash" }]);
    imap.logout.mockResolvedValue(undefined);
    smtp.verify.mockResolvedValue(true);
    ImapFlow.mockImplementation(function MockImapFlow() { return imap; });
    createTransport.mockReturnValue(smtp);
  });

  it("verifies IMAP (password auth) and TLS SMTP, reporting folder count", async () => {
    await expect(testAccountConnection("person@qq.example", password, qqProvider)).resolves.toEqual({ folders: 3, smtp: true });

    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({
      host: "imap.qq.com",
      secure: true,
      auth: { user: "person@qq.example", pass: password },
    }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      auth: { user: "person@qq.example", pass: password },
    }));
    expect(imap.connect).toHaveBeenCalledTimes(1);
    expect(imap.list).toHaveBeenCalledTimes(1);
    expect(smtp.verify).toHaveBeenCalledTimes(1);
    expect(imap.logout).toHaveBeenCalledTimes(1);
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it("rejects when IMAP credentials fail, leaving smtp unused", async () => {
    imap.connect.mockRejectedValue(Object.assign(new Error("authentication failed"), { code: "AUTHENTICATIONFAILED" }));
    await expect(testAccountConnection("person@qq.example", password, qqProvider)).rejects.toMatchObject({
      mailPhase: "imap",
      cause: expect.objectContaining({ code: "AUTHENTICATIONFAILED" }),
    });

    expect(smtp.verify).not.toHaveBeenCalled();
  });
});