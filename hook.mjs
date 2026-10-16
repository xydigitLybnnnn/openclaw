// Native PreToolUse hook stand-in for issue #173073 evidence.
// Logs the exact stdin payload codex sends, then answers per HOOK_MODE.
import fs from "node:fs";

const LOG = process.env.HOOK_LOG || "/tmp/hook-inputs.jsonl";
const MODE = process.env.HOOK_MODE || "noop";
const SLEEP_MS = Number(process.env.HOOK_SLEEP_MS || "0");

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  fs.appendFileSync(
    LOG,
    JSON.stringify({ at: new Date().toISOString(), mode: MODE, raw: input }) + "\n",
  );
} catch {}

if (MODE === "sleep") await new Promise((r) => setTimeout(r, SLEEP_MS));

if (MODE === "deny") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "risk-control policy denied this tool",
      },
    }) + "\n",
  );
} else if (MODE === "sleep-timeout") {
  // Emulate the OpenClaw relay CLI: its own deadline fires and it emits a
  // PreToolUse deny with the relay timeout reason.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay timed out",
      },
    }) + "\n",
  );
}
// MODE=noop => no stdout, exit 0.
