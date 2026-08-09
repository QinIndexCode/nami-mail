// One-shot refactor: move the compose template toggle button + picker from the
// schedule row into the quick-chips row, right-aligned. Safe for mixed EOL files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appTsx = path.join(projectRoot, "apps", "web", "src", "App.tsx");
const src = fs.readFileSync(appTsx, "utf8");

// 1. Locate the template toggle button (inside the schedule field).
const buttonStart = src.indexOf('<button className="secondary-button compose-template-toggle"');
if (buttonStart < 0) throw new Error("template toggle button not found");

// 2. The block ends right after the picker's outer </div> + ")}".
const fieldClose = src.indexOf("</span></label>", buttonStart);
if (fieldClose < 0) throw new Error("schedule field close not found");
const blockEndAnchor = src.lastIndexOf("</div>", fieldClose);
if (blockEndAnchor < 0) throw new Error("picker close not found");
// The anchor ")}" sits between the picker's </div> and </span></label>.
const tailBetween = src.slice(blockEndAnchor, fieldClose); // "</div>\n            )}"
const blockEnd = blockEndAnchor + tailBetween.indexOf(")}") + 2;
const block = src.slice(buttonStart, blockEnd);
if (!block.includes("compose-template-picker")) throw new Error("extracted block missing picker");

// 3. Remove the block from the schedule field.
const afterFieldRemoval = src.slice(0, buttonStart) + src.slice(blockEnd);
if (afterFieldRemoval === src) throw new Error("field removal failed");

// 4. Insert the block at the end of the quick-chips row (its </div> is the
//    first </div> after the quick row opener, since chips contain no divs).
const quickOpen = '<div className="compose-schedule-quick"';
const quickStart = afterFieldRemoval.indexOf(quickOpen);
if (quickStart < 0) throw new Error("quick row open not found");
const quickClose = afterFieldRemoval.indexOf("</div>", quickStart);
if (quickClose < 0) throw new Error("quick row close not found");
const afterInsert =
  afterFieldRemoval.slice(0, quickClose) + "\n            " + block + "\n          " + afterFieldRemoval.slice(quickClose);

fs.writeFileSync(appTsx, afterInsert);
console.log("template toggle moved into quick chips row");
