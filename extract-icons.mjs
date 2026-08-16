import { readFileSync } from "node:fs";

for (const f of ["tmp-win.svg", "tmp-apple.svg", "tmp-linux.svg"]) {
  const s = readFileSync(f, "utf8");
  const m = s.match(/d="([^"]+)"/);
  console.log("=== " + f + " ===");
  console.log(m ? m[1] : "NO PATH");
  console.log();
}
