import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appSettingsCoreDefaults,
  appSettingsCoreSchema,
  appSettingsPatchSchema,
} from "../src/settings.js";

test("the shipped defaults satisfy the settings contract", () => {
  // If a field is added to the schema but not to the defaults (or vice versa),
  // "restore defaults" on the web and the server store drift apart.
  const parsed = appSettingsCoreSchema.safeParse(appSettingsCoreDefaults);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
});

test("the patch schema accepts an empty body and rejects unknown fields", () => {
  assert.equal(appSettingsPatchSchema.safeParse({}).success, true);
  assert.equal(appSettingsPatchSchema.safeParse({ notASetting: 1 }).success, false);
});

test("the patch schema accepts the defaults as a full patch", () => {
  assert.equal(appSettingsPatchSchema.safeParse(appSettingsCoreDefaults).success, true);
});
