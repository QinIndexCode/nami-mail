import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { desktopLocalConfigurationFiles } from "../src/local-configuration.mts";

test("keeps translation API keys out of installed user-data configuration", () => {
  const files = desktopLocalConfigurationFiles({
    userDataPath: "C:\\Users\\Example\\AppData\\Roaming\\Nami Mail",
    appPath: "D:\\Nami Mail",
    isPackaged: true,
  });

  assert.deepEqual(files, [{
    filePath: path.join("C:\\Users\\Example\\AppData\\Roaming\\Nami Mail", "nami-mail.env"),
    environmentNames: [
      "NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID",
      "NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID",
      "NAMI_MAIL_MICROSOFT_TENANT",
      "NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS",
      "NAMI_MAIL_TRANSLATION_ENDPOINT",
      "NAMI_MAIL_TRANSLATION_TIMEOUT_MS",
    ],
  }]);
});

test("allows a translation API key only from the development project .env", () => {
  const files = desktopLocalConfigurationFiles({
    userDataPath: "C:\\Users\\Example\\AppData\\Roaming\\Nami Mail",
    appPath: "D:\\Nami Mail",
    isPackaged: false,
  });

  assert.equal(files.length, 2);
  assert.equal(files[0]?.environmentNames.includes("NAMI_MAIL_TRANSLATION_API_KEY"), false);
  assert.equal(files[1]?.filePath, path.join("D:\\Nami Mail", ".env"));
  assert.equal(files[1]?.environmentNames.includes("NAMI_MAIL_TRANSLATION_API_KEY"), true);
});
