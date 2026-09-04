import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { RuntimeContext } from "../types.js";
import { getAppSettings, getSyncMessageLimit, updateAppSettings, type AppSettings, type AppSettingsPatch } from "../settings.js";
import { emitSettingsChanged } from "../events.js";
import { config } from "../config.js";
import { validationMessage, decodedUploadHeader, MAX_BACKGROUND_UPLOAD_BYTES } from "../helpers.js";
import { settingsPatchSchema } from "../schemas.js";

const BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE = "背景图片不能超过 50 MB。";
const MAX_STORED_BACKGROUND_BYTES = 8 * 1024 * 1024;
const MAX_BACKGROUND_EDGE = 3840;
const MAX_BACKGROUND_INPUT_PIXELS = 34_000_000;
const backgroundInputTypes = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
type BackgroundInputType = keyof typeof backgroundInputTypes;

class BackgroundUploadError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const customBackgroundPattern = /^custom-background-[a-f0-9-]+\.(jpg|png|webp)$/;

function customBackgroundDirectory(context: RuntimeContext): string {
  return context.backgroundDirectory ?? path.join(path.dirname(config.databasePath), "backgrounds");
}

export function customBackgroundPath(context: RuntimeContext, filename: string | null): string | undefined {
  if (!filename || !customBackgroundPattern.test(filename)) return undefined;
  return path.join(customBackgroundDirectory(context), filename);
}

function publicSettings(context: RuntimeContext, settings: AppSettings) {
  const customPath = customBackgroundPath(context, settings.customBackgroundFilename);
  const hasCustomBackground = Boolean(customPath && fs.existsSync(customPath));
  return {
    theme: settings.theme,
    locale: settings.locale,
    backgroundPreset: settings.backgroundPreset === "custom" && !hasCustomBackground ? "coast" : settings.backgroundPreset,
    backgroundIntensity: settings.backgroundIntensity,
    notificationsEnabled: settings.notificationsEnabled,
    notifyWhenFocused: settings.notifyWhenFocused,
    notificationSound: settings.notificationSound,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    realtimePushEnabled: settings.realtimePushEnabled,
    syncMessageLimit: settings.syncMessageLimit,
    // The stored picker value above, after the SYNC_MESSAGE_LIMIT environment
    // override is applied. The renderer shows both when they diverge.
    effectiveSyncMessageLimit: getSyncMessageLimit(context.db),
    closeBehavior: settings.closeBehavior,
    launchAtStartup: settings.launchAtStartup,
    globalShortcutEnabled: settings.globalShortcutEnabled,
    agentToolRoundLimit: settings.agentToolRoundLimit,
    listDensity: settings.listDensity,
    avatarGravatarEnabled: settings.avatarGravatarEnabled,
    agentAccessLevel: settings.agentAccessLevel,
    agentCliAccessLevel: settings.agentCliAccessLevel,
    agentMcpAccessLevel: settings.agentMcpAccessLevel,
    autoReply: settings.autoReply,
    customBackgroundUrl: hasCustomBackground ? `/api/settings/background-image?v=${encodeURIComponent(settings.updatedAt)}` : null,
    updatedAt: settings.updatedAt,
  };
}

function backgroundContentType(value: string | string[] | undefined): BackgroundInputType | undefined {
  const contentType = decodedUploadHeader(value);
  return contentType && contentType in backgroundInputTypes ? contentType as BackgroundInputType : undefined;
}

async function normalizeBackgroundImage(bytes: Buffer, contentType: BackgroundInputType): Promise<{ extension: "webp"; contentType: "image/webp"; bytes: Buffer }> {
  if (!bytes.length) throw new BackgroundUploadError("背景图片不能为空。");
  if (bytes.length > MAX_BACKGROUND_UPLOAD_BYTES) {
    throw new BackgroundUploadError(BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE, 413);
  }

  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_BACKGROUND_INPUT_PIXELS,
      sequentialRead: true,
    }).metadata();
    if (metadata.format !== backgroundInputTypes[contentType]) {
      throw new BackgroundUploadError("图片格式与文件类型不一致，请重新选择 JPEG、PNG 或 WebP 图片。");
    }
    if (!metadata.width || !metadata.height) {
      throw new BackgroundUploadError("无法读取这张背景图片的尺寸。");
    }

    for (const quality of [84, 76, 68]) {
      const normalized = await sharp(bytes, {
        failOn: "error",
        limitInputPixels: MAX_BACKGROUND_INPUT_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: MAX_BACKGROUND_EDGE,
          height: MAX_BACKGROUND_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 5, smartSubsample: true })
        .toBuffer();
      if (normalized.length <= MAX_STORED_BACKGROUND_BYTES) {
        return { extension: "webp", contentType: "image/webp", bytes: normalized };
      }
    }
  } catch (error) {
    if (error instanceof BackgroundUploadError) throw error;
    throw new BackgroundUploadError("无法解析这张图片。请确认文件未损坏，并使用 JPEG、PNG 或 WebP 格式。");
  }

  throw new BackgroundUploadError("这张图片优化后仍超过 8 MB，请选择分辨率更低的图片。", 413);
}

export type SettingsRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const { context } = deps;

  app.get("/api/settings", async () => publicSettings(context, getAppSettings(context.db)));

  app.patch("/api/settings", async (request, reply) => {
    const parsed = settingsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const current = getAppSettings(context.db);
    const candidate = { ...current, ...parsed.data };
    const customPath = customBackgroundPath(context, candidate.customBackgroundFilename);
    if (candidate.backgroundPreset === "custom" && (!customPath || !fs.existsSync(customPath))) {
      return reply.code(400).send({ ok: false, message: "请先上传自定义背景图片。" });
    }
    const updated = updateAppSettings(context.db, parsed.data as AppSettingsPatch);
    if (updated.refreshIntervalSeconds !== current.refreshIntervalSeconds) {
      context.onRefreshIntervalChanged?.(updated.refreshIntervalSeconds);
    }
    if (updated.realtimePushEnabled !== current.realtimePushEnabled) {
      context.onRealtimePushChanged?.(updated.realtimePushEnabled);
    }
    // Broadcast so every connected renderer (including the one that did NOT make
    // this change, and the desktop host) re-fetches the fresh settings snapshot.
    emitSettingsChanged(context.serverEvents);
    return publicSettings(context, updated);
  });

  app.post<{ Body: Buffer }>("/api/settings/background", {
    bodyLimit: MAX_BACKGROUND_UPLOAD_BYTES,
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send({ ok: false, message: BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE });
      }
      return reply.send(error);
    },
  }, async (request, reply) => {
    const contentType = backgroundContentType(request.headers["x-nami-file-content-type"]);
    if (!contentType || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, message: "请选择 JPEG、PNG 或 WebP 格式的背景图片。" });
    }

    let image;
    try {
      image = await normalizeBackgroundImage(request.body, contentType);
    } catch (error) {
      const message = error instanceof BackgroundUploadError ? error.message : "无法处理这张背景图片。";
      const statusCode = error instanceof BackgroundUploadError ? error.statusCode : 400;
      return reply.code(statusCode).send({ ok: false, message });
    }

    const directory = customBackgroundDirectory(context);
    fs.mkdirSync(directory, { recursive: true });
    const filename = `custom-background-${randomUUID()}.${image.extension}`;
    const temporaryPath = path.join(directory, `${filename}.tmp`);
    const destinationPath = path.join(directory, filename);
    fs.writeFileSync(temporaryPath, image.bytes, { mode: 0o600 });
    fs.renameSync(temporaryPath, destinationPath);

    const previous = getAppSettings(context.db);
    try {
      const updated = updateAppSettings(context.db, {
        backgroundPreset: "custom",
        customBackgroundFilename: filename,
      });
      const previousPath = customBackgroundPath(context, previous.customBackgroundFilename);
      if (previousPath && previousPath !== destinationPath) fs.rmSync(previousPath, { force: true });
      return reply.code(201).send(publicSettings(context, updated));
    } catch (error) {
      fs.rmSync(destinationPath, { force: true });
      throw error;
    }
  });

  app.delete("/api/settings/background", async () => {
    const current = getAppSettings(context.db);
    const updated = updateAppSettings(context.db, {
      backgroundPreset: "coast",
      customBackgroundFilename: null,
    });
    const previousPath = customBackgroundPath(context, current.customBackgroundFilename);
    if (previousPath) fs.rmSync(previousPath, { force: true });
    return publicSettings(context, updated);
  });

  app.get("/api/settings/background-image", async (_request, reply) => {
    const settings = getAppSettings(context.db);
    const filePath = customBackgroundPath(context, settings.customBackgroundFilename);
    if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ ok: false, message: "未找到自定义背景。" });
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return reply.type(contentType).header("cache-control", "no-store").send(fs.readFileSync(filePath));
  });
}
