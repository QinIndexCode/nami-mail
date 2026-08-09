import { execFileSync } from "node:child_process";

const pws = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const script = [
  "$ErrorActionPreference='SilentlyContinue'",
  "Get-Process | Where-Object { $_.ProcessName -like '*Setup*' -or $_.ProcessName -like '*Nami*' } | ForEach-Object { '{0} pid={1} title=[{2}] resp={3}' -f $_.ProcessName, $_.Id, $_.MainWindowTitle, $_.Responding }",
].join("; ");
try {
  const out = execFileSync(pws, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  console.log(out.trim() || "(no matching processes)");
} catch (e) {
  console.log("ERROR " + String(e.stderr));
}
