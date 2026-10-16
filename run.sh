#!/usr/bin/env bash
# Issue #173073 evidence runner: real codex 0.160.1 + offline mock model + local MCP server
# + a native PreToolUse hook. Usage: run.sh <case-name> <HOOK_MODE> [HOOK_SLEEP_MS]
set -uo pipefail

CASE="${1:?case name required}"
HOOK_MODE="${2:-noop}"
HOOK_SLEEP_MS="${3:-0}"
HOOK_TIMEOUT="${HOOK_TIMEOUT:-10}"
MCP_APPROVAL_MODE="${MCP_APPROVAL_MODE:-}"
APPROVAL_POLICY="${APPROVAL_POLICY:-on-request}"

EVID="/media/vdb/AutoDigit/workspace/logs/real_behavior/issue-173073-evidence"
REPO="/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn"
CODEX="$REPO/node_modules/.pnpm/@openai+codex@0.160.1-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex"
PORT="${PORT:-8791}"

OUT="$EVID/runs/$CASE"
rm -rf "$OUT"; mkdir -p "$OUT"
WORK="$OUT/workspace"; CODEX_HOME="$OUT/codex-home"
mkdir -p "$WORK" "$CODEX_HOME"

MCP_APPROVAL_LINE=""
[ -n "$MCP_APPROVAL_MODE" ] && MCP_APPROVAL_LINE="default_tools_approval_mode = \"$MCP_APPROVAL_MODE\""

cat > "$CODEX_HOME/config.toml" <<EOF
model = "mock-codex"
model_provider = "mock"
approval_policy = "on-request"
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

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "node $EVID/hook.mjs"
timeout = $HOOK_TIMEOUT
async = false
EOF

export MOCK_API_KEY="offline"
export HOOK_LOG="$OUT/hook-inputs.jsonl"
export HOOK_MODE="$HOOK_MODE"
export HOOK_SLEEP_MS="$HOOK_SLEEP_MS"
export PROVIDER_LOG="$OUT/provider-requests.jsonl"
export MCP_CALL_LOG="$OUT/mcp-calls.jsonl"
export PORT

node "$EVID/mock-provider.mjs" > "$OUT/provider.out" 2>&1 &
PROVIDER_PID=$!
for _ in $(seq 1 50); do grep -q MOCK_PROVIDER_READY "$OUT/provider.out" 2>/dev/null && break; sleep 0.1; done

CODEX_HOME="$CODEX_HOME" timeout 180 "$CODEX" exec \
  --dangerously-bypass-hook-trust \
  --skip-git-repo-check \
  -c "approval_policy=\"$APPROVAL_POLICY\"" \
  --json \
  -C "$WORK" \
  "Call the probe MCP tool exactly once with q=reconcile, then reply DONE." \
  < /dev/null > "$OUT/codex-stdout.jsonl" 2> "$OUT/codex-stderr.txt"
echo "codex_exit=$?" > "$OUT/result.txt"

kill "$PROVIDER_PID" 2>/dev/null
wait "$PROVIDER_PID" 2>/dev/null

{
  echo "case=$CASE hook_mode=$HOOK_MODE sleep_ms=$HOOK_SLEEP_MS hook_timeout=$HOOK_TIMEOUT mcp_approval=$MCP_APPROVAL_MODE"
  echo "--- codex exit ---"; cat "$OUT/result.txt"
  echo "--- mcp calls ---"; cat "$OUT/mcp-calls.jsonl" 2>/dev/null || echo "(none)"
  echo "--- hook inputs ---"; cat "$OUT/hook-inputs.jsonl" 2>/dev/null || echo "(none)"
  echo "--- codex stdout ---"; cat "$OUT/codex-stdout.jsonl" 2>/dev/null
  echo "--- codex stderr (grep hook/approval/block) ---"; grep -iE "hook|approval|block|denied|elicit|permission" "$OUT/codex-stderr.txt" 2>/dev/null | tail -20
} > "$OUT/summary.txt"
echo "DONE $CASE -> $OUT"
