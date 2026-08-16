import { get } from "node:https";
import { writeFileSync } from "node:fs";

const url = "https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/windows.svg";
get(url, { headers: { "user-agent": "Mozilla/5.0" } }, (r) => {
  let d = "";
  r.on("data", (c) => (d += c));
  r.on("end", () => {
    writeFileSync("tmp-win3.svg", d);
    console.log("bytes:", d.length);
    const m = d.match(/d="([^"]+)"/);
    console.log(m ? m[1] : "no path");
  });
}).on("error", (e) => console.log("ERR", e.message));
