# Issue #173073 — text screenshot: MCP plugin approval under the Codex runtime

Terminal capture generated from the real, re-runnable runs in `runs/` (real `codex-cli 0.160.1`,
offline mock Responses provider, local stdio MCP server, real native `PreToolUse` hook).
Reproduce with `./run.sh <case> <hook-mode>` as listed in `README.md`.

Legend: `BEFORE` = current upstream behaviour on `main`; `AFTER` = behaviour with this PR.

---

## 1. BEFORE — why a gated MCP call could never wait

### 1a. Codex emits no approval-mode marker for MCP tools

```
$ ./run.sh baseline-noop noop          # runs/baseline-noop/hook-inputs.jsonl
{"session_id":"…","turn_id":"…","transcript_path":"…","cwd":"…",
 "hook_event_name":"PreToolUse","model":"mock-codex","permission_mode":"bypassPermissions",
 "tool_name":"mcp__probe__probe","tool_input":{"q":"reconcile"},"tool_use_id":"call_1"}
```

No `openclaw_approval_mode`. OpenClaw's relay therefore never sees `report` for an MCP call,
so the plugin approval was fulfilled synchronously inside the short-lived hook subprocess,
which is bounded at ~9 s (10 s hook timeout − 1 s parent margin) → always fail-closed:

```
Tool call blocked by PreToolUse hook: Native hook relay timed out
```

### 1b. PreToolUse is a real execution gate — and Codex is fail-open on hook timeout

```
$ ./run.sh hook-deny deny              # runs/hook-deny/…/rollout-…jsonl
Tool call blocked by PreToolUse hook: risk-control policy denied this tool. Tool: mcp__probe__probe
```

The MCP tool did **not** run (`runs/hook-deny/` has no `mcp-calls.jsonl`).

```
$ HOOK_TIMEOUT=5 ./run.sh hook-timeout sleep 20000    # hook sleeps 20s, Codex timeout 5s
$ ls runs/hook-timeout/mcp-calls.jsonl
runs/hook-timeout/mcp-calls.jsonl                     # present → the MCP tool DID execute
```

So the ~9 s fail-closed is **OpenClaw's relay CLI deadline**, not Codex. A no-op, a removed
block, or an expired hook would execute the tool **with no human decision** — the
authorization-bypass risk.

---

## 2. AFTER — the human wait moves to Codex's own MCP approval

Codex raises `mcpServer/elicitation/request` for every projected approval mode except `approve`:

```
$ ./run-appserver.sh prompt           # runs/appserver-prompt-nohook/app-server-messages.jsonl
{"method":"mcpServer/elicitation/request","id":0,"params":{
  "threadId":"…","turnId":"…","serverName":"probe","mode":"form",
  "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],
           "tool_description":"…","tool_params":{"q":"reconcile"},"tool_params_display":[…]}}}
```

preceded by `item/started` (`mcpToolCall`, `id:"call_1"`) and
`thread/status/changed {activeFlags:["waitingOnApproval"]}`; answering
`{"action":"decline"}` produced `mcpToolCall status:"failed"` with **no tool execution**.

### App-server matrix (real `codex app-server`)

| `default_tools_approval_mode` | `mcpServer/elicitation/request` | tool executed |
|---|---|---|
| `approve` | no | yes (ungated) |
| `auto` | **yes** | no (declined in the run) |
| `prompt` | **yes** | no (declined in the run) |

With this PR the plugin's `requireApproval` on an `mcp__*` PreToolUse event is parked on the relay
and answered with no native decision, so the human wait lives at this in-process elicitation
instead of the 9 s hook deadline. Servers projected to `approve` (no elicitation) and unresolved
native server names keep the hook in custody — nothing executes ungated.

---

## 3. Regression test added by this PR

```
src/agents/harness/native-hook-relay.mcp-defer.test.ts
  ✓ parks a plugin-gated MCP approval on the relay for Codex to resolve

Test Files  2 passed (2)
     Tests  62 passed (62)
```

The assertion is discriminating: the deferred approval requester is only reached when the hook
returned no native decision; an in-custody hook never reaches it.
