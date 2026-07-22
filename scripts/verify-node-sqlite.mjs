import path from "node:path";
import process from "node:process";
import {
  assertWindowsSqlitePrebuild,
  projectRoot,
  querySqliteWithCurrentNode,
} from "./sqlite-native.mjs";

const prebuildPath = assertWindowsSqlitePrebuild();
querySqliteWithCurrentNode();

console.log(JSON.stringify({
  runtime: "node",
  abi: process.versions.modules,
  napi: process.versions.napi,
  prebuild: path.relative(projectRoot, prebuildPath),
}));
