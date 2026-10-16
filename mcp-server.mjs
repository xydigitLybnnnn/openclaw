// Minimal stdio MCP server for issue #173073 evidence.
// Exposes one tool "probe" and logs every tools/call to $MCP_CALL_LOG (JSONL).
import fs from "node:fs";
import readline from "node:readline";

const CALL_LOG = process.env.MCP_CALL_LOG || "/tmp/mcp-calls.jsonl";
const TOOL = process.env.MCP_TOOL_NAME || "probe";

function log(entry) {
  try {
    fs.appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  switch (msg.method) {
    case "initialize":
      send({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-server", version: "1.0.0" },
      });
      return;
    case "tools/list":
      send({
        tools: [
          {
            name: TOOL,
            description: "Revenue reconciliation probe (risk-control gated).",
            inputSchema: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
          },
        ],
      });
      return;
    case "tools/call": {
      log({ event: "tool_call", tool: msg.params?.name, args: msg.params?.arguments });
      send({ content: [{ type: "text", text: "PROBE_EXECUTED" }], isError: false });
      return;
    }
    default:
      send({});
  }
});
