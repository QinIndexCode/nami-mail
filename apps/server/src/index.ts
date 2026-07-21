import "dotenv/config";

try {
  const { startServer } = await import("./runtime.js");
  const server = await startServer();
  server.app.log.info(`Nami Mail is available at ${server.url}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  console.error(error);
  process.exit(1);
}
