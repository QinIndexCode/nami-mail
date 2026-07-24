import path from "node:path";

export const installedDesktopConfigurationEnvironmentNames = [
  "NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID",
  "NAMI_MAIL_MICROSOFT_TENANT",
  "NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS",
  "NAMI_MAIL_TRANSLATION_ENDPOINT",
  "NAMI_MAIL_TRANSLATION_TIMEOUT_MS",
] as const;

export const developmentDesktopConfigurationEnvironmentNames = [
  ...installedDesktopConfigurationEnvironmentNames,
  "NAMI_MAIL_TRANSLATION_API_KEY",
] as const;

export type DesktopLocalConfigurationFile = {
  filePath: string;
  environmentNames: readonly string[];
};

export function desktopLocalConfigurationFiles(options: {
  userDataPath: string;
  appPath: string;
  isPackaged: boolean;
}): DesktopLocalConfigurationFile[] {
  const files: DesktopLocalConfigurationFile[] = [{
    filePath: path.join(options.userDataPath, "nami-mail.env"),
    environmentNames: installedDesktopConfigurationEnvironmentNames,
  }];
  if (!options.isPackaged) {
    files.push({
      filePath: path.join(options.appPath, ".env"),
      environmentNames: developmentDesktopConfigurationEnvironmentNames,
    });
  }
  return files;
}
