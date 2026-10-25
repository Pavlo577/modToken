// Probe for Claude Code's statusLine input. Writes only the SHAPE of the input to
// ~/.claude/statusline-probe.log: keys, numbers and booleans as values, strings as length only.
// Prints a short line for the status bar. Remove it after the check.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
const flat = {};
const walk = (v, p) => {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  else if (typeof v === "number" || typeof v === "boolean") flat[p] = v;
  else flat[p] = typeof v === "string" ? `str:${v.length}` : String(v);
};
try { walk(JSON.parse(raw), ""); } catch { flat._parse_error = raw.length; }
try { appendFileSync(join(homedir(), ".claude", "statusline-probe.log"), JSON.stringify({ t: new Date().toISOString(), ...flat }) + "\n"); } catch {}
process.stdout.write("probe");
