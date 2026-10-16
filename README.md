# Issue #173073 — 容器内真实 codex 验证证据

- 目标：用**真实 codex 0.160.1 二进制**验证「MCP 工具的 PreToolUse 插件审批在 codex runtime 下无可用等待路径」，并据实给出修复方案。
- codex：`codex-cli 0.160.1`（仓库 pin `@openai/codex 0.160.1`，musl 静态二进制，host 与容器内均可运行）。
- 方式：离线 mock OpenAI Responses 提供方 + 本地 stdio MCP server + 真实 codex 原生 `PreToolUse` hook；无需外网、无模型鉴权依赖。
- 运行环境：可复现；脚本见同目录 `run.sh` / `mock-provider.mjs` / `mcp-server.mjs` / `hook.mjs`，逐案日志见 `runs/`。

## 结论摘要

| 编号 | 事实 | 证据 |
|---|---|---|
| E1 | codex 为 MCP 工具触发 `PreToolUse`，payload 中**没有** `openclaw_approval_mode` | `runs/baseline-noop/hook-inputs.jsonl` |
| E2 | `PreToolUse` 是 MCP 工具**真实的执行门禁**：`deny` 会阻止执行 | `runs/hook-deny/`（`mcp-calls` 为空，codex 报 `Tool call blocked by PreToolUse hook: ... Tool: mcp__probe__probe`） |
| E3 | codex 在 hook **超时后 fail-open**：工具仍被执行 | `runs/hook-timeout/`（hook `timeout=5`、hook 睡 20s，约 5s 后 MCP 工具被调用并执行） |
| E4 | codex 侧**没有** MCP 专用的 app-server 审批方法；MCP 审批只经由 `mcpServer/elicitation/request`（elicitation） | 二进制 server-request 方法集：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call` |
| E5 | MCP `default_tools_approval_mode` 合法取值为 `auto｜prompt｜writes｜approve` | `runs/mcp-onrequest`（`on_request` 被判非法，codex 打印候选值） |

## E1 — MCP 工具的 PreToolUse payload（原样）

```json
{"session_id":"...","turn_id":"...","transcript_path":"...","cwd":"...",
 "hook_event_name":"PreToolUse","model":"mock-codex","permission_mode":"bypassPermissions",
 "tool_name":"mcp__probe__probe","tool_input":{"q":"reconcile"},"tool_use_id":"call_1"}
```

无 `openclaw_approval_mode`。这与仓库源码一致：`readNativeHookRelayApprovalMode()` 只会读到 `report`（[native-hook-relay-codec.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/src/agents/harness/native-hook-relay-codec.ts#L128-L131)），而 exec 的 `report` 标记是 OpenClaw 自己合成 payload 时写入的（[approval-bridge.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/extensions/codex/src/app-server/approval-bridge.ts#L551-L559)）。**codex 生成的 MCP payload 永远不会有该标记**（二进制中该字符串出现 0 次）。

## E2/E3 — 门禁与 fail-open（关键）

- `deny`（`runs/hook-deny`）：MCP 工具**未**执行；codex 日志：
  `error=Tool call blocked by PreToolUse hook: risk-control policy denied this tool. Tool: mcp__probe__probe`
- `noop`（`runs/baseline-noop`）：MCP 工具**执行**。
- `hook timeout=5s + hook 睡 20s`（`runs/hook-timeout`）：约 5s（codex 的 hook 超时）后 codex 继续，**MCP 工具照样执行**，即 **codex 对 PreToolUse 超时是 fail-open**。

推论（改写原 issue 的关键前提）：当前「9s 后 fail-closed」并非 codex 的行为，而是 **OpenClaw 的 relay CLI 主动在 9s 到点时自己输出 deny（`Native hook relay timed out`）** 造成的（[native-hook-relay-cli.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/src/cli/native-hook-relay-cli.ts#L98-L101)，deadline 9000ms 来自 [native-hook-relay.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/extensions/codex/src/app-server/native-hook-relay.ts#L47) 与 [resolveCodexNativeHookRelayCommandTimeoutMs](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/extensions/codex/src/app-server/native-hook-relay.ts#L675-L689)）。
也就是说：**如果只是"去掉在 hook 里的阻塞/让它超时/直接返回 no-op"，工具会在没有任何人工决策的情况下被执行——这正是授权绕过风险**（与 clawsweeper 的 medium 安全告警一致）。

## E4/E5 — MCP 审批的既有可用通道

- codex 对 MCP 的审批走 **elicitation**（`mcpServer/elicitation/request`，feature `tool_call_mcp_elicitation`），由**主进程**处理，不占用短命 hook 子进程。
- OpenClaw 已具备：elicitation 桥（[elicitation-bridge.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/extensions/codex/src/app-server/elicitation-bridge.ts)）、以及把每服务器审批模式投影进 codex 的配置能力（`mcp.servers.<name>.codex.defaultToolsApprovalMode` = `auto|prompt|approve`，见 [zod-schema.mcp-server.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/src/config/zod-schema.mcp-server.ts#L69)）。
- 相关常量：`DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000`，`MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000`（[plugin-approvals.ts](/media/vdb/AutoDigit/workspace/repos/openclaw-xydigitLybnnnn/src/infra/plugin-approvals.ts#L80-L81)）。

## 复现命令

```bash
cd /media/vdb/AutoDigit/workspace/logs/real_behavior/issue-173073-evidence
./run.sh baseline-noop noop                 # E1 + 基线（工具执行）
./run.sh hook-deny deny                     # E2（deny 阻断）
HOOK_TIMEOUT=5 ./run.sh hook-timeout sleep 20000   # E3（codex 超时 fail-open）
MCP_APPROVAL_MODE=prompt ./run.sh mcp-prompt noop  # E5（enum 校验）
```

## App-server 复验（决定 B′ 是否成立）

`codex exec` 会强制 `approval_policy=Never`，测不到审批路径。改用**真实 `codex app-server`**（stdio JSON-RPC：`initialize` → `thread/start` → `turn/start`，脚本 `run-appserver.sh` + `app-server-driver.mjs`，协议取自 `codex app-server generate-json-schema`）：

| MCP `default_tools_approval_mode` | codex 是否发 `mcpServer/elicitation/request` | 工具是否执行 |
|---|---|---|
| `approve` | **否** | **是**（无门禁） |
| `auto` | **是** | 否（本实验 decline） |
| `prompt` | **是** | 否（本实验 decline） |

`prompt` 场景实证（`runs/appserver-prompt-nohook/`）：先 `item/started`(`mcpToolCall`,`id:"call_1"`) → `thread/status/changed {activeFlags:["waitingOnApproval"]}` → 服务器请求：

```json
{"method":"mcpServer/elicitation/request","id":0,"params":{
  "threadId":"...","turnId":"...","serverName":"probe","mode":"form",
  "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],
           "tool_description":"...","tool_params":{"q":"reconcile"},"tool_params_display":[...]},
  "message":"Allow the probe MCP server to run tool \"probe\"?",
  "requestedSchema":{"type":"object","properties":{}}}}
```

回复 `{action:"decline"}` 后：`item/completed`(`mcpToolCall`,`status:"failed"`)，**工具未执行**（`mcp-calls` 为空）。

### 关键结论（F）

**codex 对 MCP 审批确实存在 out-of-band 人工等待通道**（`mcpServer/elicitation/request`，由主进程处理，不占用短命 hook 子进程）；当服务器审批模式为 `auto`/`prompt` 时 codex 必然先 elicit 再执行，`decline` 可阻止执行。`_meta.codex_approval_kind="mcp_tool_call"` 正是 OpenClaw elicitation 桥识别的键。

⇒ 因此「PreToolUse 对 MCP defer + 走 elicitation 承接人工等待」（方案 B′）**无需改动 codex**，在本 pin 版本上成立。

限制：该 elicitation 只带 `serverName`/`turnId`（无 tool-call id），与具体调用的关联需依赖当时的 active `mcpToolCall`（server+tool+args）——比 commandExecution 的显式 approval id 弱，必须保留指纹绑定与失权 fail-closed。

## 尚未验证 / 已知边界

- `codex exec` 强制 `approval_policy=Never`；`approval_policy="untrusted"` 已不再支持（`runs/mcp-prompt-untrusted/`）。审批行为只能在 app-server 下观察。
- `auto` 与 `prompt` 均会 elicit；本实验只验证了 `approve` 为无门禁。其余语义（`writes`）未逐一验证。
- 未验证「OpenClaw elicitation 桥在真实网关中把该 elicitation 消费为人工等待」的端到端路径（需要 OpenClaw 网关 + 真实 codex app-server 联跑）。
- 未验证 codex 对 PreToolUse hook 超时的 fail-open 在 app-server（非 exec）下是否一致。

