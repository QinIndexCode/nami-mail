import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { ZipFile } from "yazl";
import { collectMailBackup } from "../backup.js";
import { contentDispositionFilename } from "../helpers.js";

export type BackupRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const { context, log } = deps;

  app.get("/api/backup", async (_request, reply) => {
    // Streams every stored message's provider source as .eml entries inside
    // one zip. Entries are appended as they arrive so memory stays bounded
    // regardless of mailbox size; per-message failures land in the report.
    const zip = new ZipFile();
    // A client disconnect will emit on the output stream; swallow it — the
    // socket error is already handled by Fastify and a crash here would only
    // take the process down with an already-aborted transfer.
    zip.outputStream.on("error", () => undefined);
    const backupDate = new Date().toISOString().slice(0, 10);
    reply
      .type("application/zip")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${contentDispositionFilename(`nami-mail-backup-${backupDate}.zip`)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    reply.send(zip.outputStream);
    try {
      const report = await collectMailBackup(context.db, context.masterKey, {
        accessTokenProvider: context.oauthService,
        emit: (entry) => zip.addBuffer(entry.source, entry.path),
      });
      zip.addBuffer(Buffer.from(`${JSON.stringify(report, null, 2)}\n`), "export-report.json");
    } catch (error) {
      zip.addBuffer(
        Buffer.from(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)),
        "export-error.json",
      );
    } finally {
      zip.end();
    }
    return reply;
  });
}
