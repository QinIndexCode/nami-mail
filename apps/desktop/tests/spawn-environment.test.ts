import assert from "node:assert/strict";
import test from "node:test";
import { minimalSpawnEnvironment } from "../src/spawn-environment.mts";

test("allowlists only system variables and drops empty values", () => {
  process.env.PATH = "C:\\Windows\\System32";
  process.env.SystemRoot = "C:\\Windows";
  process.env.NAMI_MAIL_LOCAL_API_TOKEN = "should-never-leak";
  process.env.NAMI_MAIL_TRANSLATION_API_KEY = "should-never-leak";
  process.env.EMPTY_MARKER = "";
  assert.equal(process.env.EMPTY_MARKER, "");
  const environment = minimalSpawnEnvironment();
  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.NAMI_MAIL_LOCAL_API_TOKEN, undefined);
  assert.equal(environment.NAMI_MAIL_TRANSLATION_API_KEY, undefined);
  assert.equal(environment.EMPTY_MARKER, undefined);
  assert.ok(!Object.keys(environment).some((key) => key.startsWith("NAMI_MAIL_")));
});

test("extra variables override and are not filtered", () => {
  process.env.PATH = "/usr/bin:/bin";
  const environment = minimalSpawnEnvironment({
    PATH: "/opt/custom/bin:/usr/bin",
    NAMI_MAIL_SIGNATURE_TARGET: "C:\\Program Files\\Nami Mail\\Nami Mail.exe",
  });
  assert.equal(environment.PATH, "/opt/custom/bin:/usr/bin");
  assert.equal(environment.NAMI_MAIL_SIGNATURE_TARGET, "C:\\Program Files\\Nami Mail\\Nami Mail.exe");
});

test("missing variables are simply absent", () => {
  delete process.env.PATH;
  const environment = minimalSpawnEnvironment();
  assert.equal(environment.PATH, undefined);
});