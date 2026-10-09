#!/usr/bin/env node
/** Serve the built public site locally, including its shared-client demo. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
const port = Number(process.env.NAMI_SITE_PORT || 5176);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("NAMI_SITE_PORT must be a valid port");
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".wasm": "application/wasm",
};

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let path = resolve(siteRoot, "." + decodeURIComponent(url.pathname));
    if (path !== siteRoot && !path.startsWith(siteRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Nami Mail site preview: http://127.0.0.1:${port}/`));
