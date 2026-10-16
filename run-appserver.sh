#!/usr/bin/env bash
# App-server elicitation probe for issue #173073.
# Usage: run-appserver.sh <case> [HOOK_MODE] ; env: MCP_APPROVAL_MODE, APPROVAL_POLICY, WITH_HOOK
set -uo pipefail

CASE="${1:?case name required}"
HOOK_MODE="${2:-none}"
MCP_APPROVAL_MODE="${MCP_APPROVAL_MODE:-prompt}"
APPROVAL_POLICY="${APPROVAL_POLICY:-on-request}"
WITH_HOOK="${WITH_HOOK:-0}"

EVID="/media/vdb/AutoDigit/workspace/logs/real_behavior/issue-173073-evidence"
REPO="/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn"
CODEX="$REPO/node_modules/.pnpm/@openai+codex@0.160.1-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex"
PORT="${PORT:-8792}"

OUT="$EVID/runs/appserver-$CASE"
rm -rf "$OUT"; mkdir -p "$OUT"
WORK="$OUT/workspace"; CODEX_HOME="$OUT/codex-home"
mkdir -p "$WORK" "$CODEX_HOME"

HOOK_BLOCK=""
if [ "$WITH_HOOK" = "1" ]; then
HOOK_BLOCK="
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = \"command\"
command = \"node $EVID/hook.mjs\"
timeout = 10
async = false
"
fi

MCP_APPROVAL_LINE=""
if [ "$MCP_APPROVAL_MODE" != "unset" ]; then
  MCP_APPROVAL_LINE="default_tools_approval_mode = \"$MCP_APPROVAL_MODE\""
fi

cat > "$CODEX_HOME/config.toml" <<EOF
model = "mock-codex"
model_provider = "mock"
sandbox_mode = "danger-full-access"

[features]
hooks = true

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$PORT/v1"
wire_api = "responses"
env_key = "MOCK_API_KEY"
requires_openai_auth = false

[mcp_servers.probe]
command = "node"
args = ["$EVID/mcp-server.mjs"]
startup_timeout_sec = 20
$MCP_APPROVAL_LINE
env = { MCP_CALL_LOG = "$OUT/mcp-calls.jsonl", MCP_TOOL_NAME = "probe" }

[projects."$WORK"]
trust_level = "trusted"
$HOOK_BLOCK
EOF

export MOCK_API_KEY="offline"
export HOOK_LOG="$OUT/hook-inputs.jsonl"
export HOOK_MODE="$HOOK_MODE"
export PROVIDER_LOG="$OUT/provider-requests.jsonl"
export MCP_CALL_LOG="$OUT/mcp-calls.jsonl"
export PORT

node "$EVID/mock-provider.mjs" > "$OUT/provider.out" 2>&1 &
PROVIDER_PID=$!
for _ in $(seq 1 50); do grep -q MOCK_PROVIDER_READY "$OUT/provider.out" 2>/dev/null && break; sleep 0.1; done

CODEX_BIN="$CODEX" CODEX_HOME="$CODEX_HOME" WORK="$WORK" \
  APPSERVER_LOG="$OUT/app-server-messages.jsonl" CODEX_STDERR="$OUT/codex-stderr.txt" \
  APPROVAL_POLICY="$APPROVAL_POLICY" TURN_TIMEOUT_MS=45000 \
  node "$EVID/app-server-driver.mjs" > "$OUT/driver.out" 2>&1

kill "$PROVIDER_PID" 2>/dev/null; wait "$PROVIDER_PID" 2>/dev/null

{
  echo "case=$CASE mcp_approval=$MCP_APPROVAL_MODE approval_policy=$APPROVAL_POLICY with_hook=$WITH_HOOK hook_mode=$HOOK_MODE"
  echo "--- server->client requests observed ---"
  grep -o '"method":"[^"]*"' "$OUT/app-server-messages.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | head -20
  echo "--- elicitation requests ---"
  grep -c "mcpServer/elicitation/request" "$OUT/app-server-messages.jsonl" 2>/dev/null
  echo "--- mcp calls ---"; cat "$OUT/mcp-calls.jsonl" 2>/dev/null || echo "(none)"
  echo "--- hook inputs ---"; cat "$OUT/hook-inputs.jsonl" 2>/dev/null || echo "(none)"
} > "$OUT/summary.txt"
echo "DONE appserver-$CASE -> $OUT"
