/**
 * 批次 0 护栏 · 发信的本地优先（架构契约 §9 的 T4，对应用户投诉的第二号问题）。
 *
 * 契约 I2 要求改动型请求的响应**不含** provider 网络往返。旧实现把
 * `await sendMail(...)` 放在响应窗口内，所以本测试原本断言"响应被 SMTP 阻塞"——
 * 那时它是刻意写成会失败的样子。第 3 件·5 之后发信变成"接受 + 202 + 一条派发任务"，
 * 断言因此翻转为"响应不等 SMTP"。
 *
 * **注意断言的是"不等"而不是"没碰"**：接受提交后调度器立刻认领任务并拨号，
 * socket 常常在响应写出之前就被调用了——这是设计（发出去不等人），不是漏网。
 * 被否掉的只有"等"：闸门锁着的时候响应必须已经回来。
 *
 * 用一道手动放行的闸门而不是计时来判定"没有等待"：只要响应先到、而闸门还没
 * 放行，响应就不可能是在等 socket。闸门与机器快慢无关，但下面那道 race 的预算
 * 是墙钟的——它给整条接受路径（含 `acceptSendTask` 的同步事务）留下时限，所以
 * 预算取得宽：慢机器只该多花几毫秒，不该假红；真的在等 socket 的实现在这里等不到
 * 放行（放行的代码在断言之后），无论预算多宽都会落在 "blocked" 上。
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

// Fastify's inject stamps "Host: localhost:80" on requests with no host header,
// and the token-less Host allowlist in src/app.ts only accepts this server's own
// loopback authorities on the configured port.
vi.hoisted(() => {
  process.env.PORT = "80";
});

const { sendMail, imapClientForAccount } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  imapClientForAccount: vi.fn(),
}));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, sendMail, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { countOf } from "./helpers/legacy-store.js";
import { waitForSendTask } from "./helpers/send-settlement.js";

const NOW = "2026-10-16T00:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 7);

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    )
    VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, NOW);
}

describe("T4 · 发信是本地优先：响应不等 SMTP 往返", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    sendMail.mockReset();
    imapClientForAccount.mockReset();
    // Sent verification and the post-send paths would open IMAP; they are not
    // part of what this test measures, so the client stays unavailable.
    imapClientForAccount.mockReturnValue(undefined as never);
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
    app = await buildApp({ db, masterKey: MASTER_KEY });
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it("SMTP 挂起时 /api/messages/send 仍然立即返回 202，不等这次往返", async () => {
    let releaseSend = (): void => undefined;
    const smtpGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    sendMail.mockImplementation(async () => {
      await smtpGate;
      return { messageId: "<sent@example.test>" };
    });

    const request = app.inject({
      method: "POST",
      url: "/api/messages/send",
      payload: { accountId: "account-1", to: ["to@example.test"], subject: "主题", text: "正文" },
    });

    const outcome = await Promise.race([
      request.then(() => "responded" as const),
      new Promise<"blocked">((resolve) => { setTimeout(() => resolve("blocked"), 2000); }),
    ]);

    // 闸门还锁着，响应已经到了：这就是契约 I2 要的那件事——响应窗口里没有
    // provider 往返。旧实现的同一 race 落在 "blocked" 上，翻转即验收。
    expect(outcome).toBe("responded");

    const response = await request;
    expect(response.statusCode).toBe(202);
    const body = response.json() as { deliveryStatus: string; status: string; taskId?: string; submission: { id: string } };
    expect(body).toMatchObject({ deliveryStatus: "pending", status: "pending" });
    // 这条请求**故意不带** `idempotencyKey`（清单见 contract §十七 (8)）：缺键时
    // `prepareSubmission` 每调一次就新铸一个，所以"谁来创建这次提交"只要有两个调用者，
    // 这里就会多出一行台账——一行永远没有任务去派发的台账。两个计数各为 1 就是
    // "唯一创建者"这句话的见证：一条提交 + 一条派发它的任务，没有第三条路。
    expect(countOf(db, "SELECT COUNT(*) FROM outbound_submissions")).toBe(1);
    expect(countOf(db, "SELECT COUNT(*) FROM tasks")).toBe(1);
    expect(body.taskId).toBeTruthy();
    // 任务 id 就是提交 id（§十七 (5)·D3b）：任务行的主键因此也是"同一条提交只能
    // 派发一次"的守卫——第二次派发会撞主键，而不是给同一封信派两个发送者。这条
    // 等式一旦松动，两个 id 各自合法、各自可查，重复派发就再也无人拦得住。
    expect(body.taskId).toBe(body.submission.id);

    // 放行之后任务才把这次发送走完：往返搬进了它命名的任务里，而且只走一次。
    releaseSend();
    await expect(waitForSendTask(db, body.taskId!)).resolves.toEqual({ status: "completed", errorCode: null });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
