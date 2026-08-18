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
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    const port = process.env.PORT?.trim() || "3187";
    console.error(
      "\n[nami-mail] 启动失败：本地服务端口 " + port + " 已被占用。\n" +
        "可能已经有另一个 Nami Mail 实例（桌面应用或开发服务）正在运行。\n" +
        "请先关闭它，或设置环境变量 PORT 改用其他端口后重试。\n",
    );
  } else {
    console.error("\n[nami-mail] 启动失败：", error);
  }
  process.exit(1);
}
