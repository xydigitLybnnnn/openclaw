// Verifies config path normalization and platform-specific behavior.
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { normalizeConfigPaths } from "./normalize-paths.js";

describe("normalizeConfigPaths", () => {
  it("expands tilde for path-ish keys only", async () => {
    await withTempHome(async (home) => {
      const cfg = normalizeConfigPaths({
        worktreeRoot: "~/worktrees",
        tools: { exec: { pathPrepend: ["~/bin"] } },
        plugins: { load: { paths: ["~/plugins/a"] } },
        logging: { file: "~/.openclaw/logs/openclaw.log" },
        hooks: {
          path: "~/.openclaw/hooks.json5",
          transformsDir: "~/hooks-xform",
        },
        channels: {
          telegram: {
            accounts: {
              personal: {
                tokenFile: "~/.openclaw/telegram.token",
              },
            },
          },
          whatsapp: {
            accounts: {
              personal: {
                authDir: "~/.openclaw/credentials/wa-personal",
              },
            },
          },
          imessage: {
            accounts: { personal: { dbPath: "~/Library/Messages/chat.db" } },
          },
        },
        agents: {
          defaults: { workspace: "~/ws-default" },
          list: [
            {
              id: "main",
              workspace: "~/ws-agent",
              agentDir: "~/.openclaw/agents/main",
              identity: {
                name: "~not-a-path",
              },
              sandbox: { workspaceRoot: "~/sandbox-root" },
            },
          ],
        },
      });

      expect(cfg.worktreeRoot).toBe(path.join(home, "worktrees"));
      expect(cfg.plugins?.load?.paths?.[0]).toBe(path.join(home, "plugins", "a"));
      expect(cfg.logging?.file).toBe(path.join(home, ".openclaw", "logs", "openclaw.log"));
      expect(cfg.hooks?.path).toBe(path.join(home, ".openclaw", "hooks.json5"));
      expect(cfg.hooks?.transformsDir).toBe(path.join(home, "hooks-xform"));
      expect(cfg.tools?.exec?.pathPrepend?.[0]).toBe(path.join(home, "bin"));
      expect(cfg.channels?.telegram?.accounts?.personal?.tokenFile).toBe(
        path.join(home, ".openclaw", "telegram.token"),
      );
      expect(cfg.channels?.whatsapp?.accounts?.personal?.authDir).toBe(
        path.join(home, ".openclaw", "credentials", "wa-personal"),
      );
      expect(cfg.channels?.imessage?.accounts?.personal?.dbPath).toBe(
        path.join(home, "Library", "Messages", "chat.db"),
      );
      expect(cfg.agents?.defaults?.workspace).toBe(path.join(home, "ws-default"));
      expect(cfg.agents?.list?.[0]?.workspace).toBe(path.join(home, "ws-agent"));
      expect(cfg.agents?.list?.[0]?.agentDir).toBe(path.join(home, ".openclaw", "agents", "main"));
      expect(cfg.agents?.list?.[0]?.sandbox?.workspaceRoot).toBe(path.join(home, "sandbox-root"));

      // Non-path key => do not treat "~" as home expansion.
      expect(cfg.agents?.list?.[0]?.identity?.name).toBe("~not-a-path");
    });
  });

  it("returns a normalized copy without mutating the input config", async () => {
    await withTempHome(async (home) => {
      // Plugin passthrough config keeps its original object reference in validated
      // configs, so an in-place normalize would leak expanded paths into sourceConfig.
      const sharedVault = { path: "~/.openclaw/wiki", scope: "global" };
      const input = {
        logging: { file: "~/.openclaw/logs/openclaw.log" },
        plugins: { entries: { "memory-wiki": { config: { vault: sharedVault } } } },
      };

      const normalized = normalizeConfigPaths(input);

      expect(normalized).not.toBe(input);
      expect(normalized.logging?.file).toBe(path.join(home, ".openclaw", "logs", "openclaw.log"));
      expect(
        (normalized.plugins?.entries?.["memory-wiki"]?.config as { vault?: { path?: string } })
          ?.vault?.path,
      ).toBe(path.join(home, ".openclaw", "wiki"));
      // Original input and the shared nested object must stay untouched.
      expect(input.logging.file).toBe("~/.openclaw/logs/openclaw.log");
      expect(sharedVault.path).toBe("~/.openclaw/wiki");
    });
  });

  it("preserves structural sharing for branches without tilde paths", async () => {
    await withTempHome(async () => {
      const untouched = { enabled: true, nested: { value: 1 } };
      const input = { plugins: { entries: { demo: { config: untouched } } } };

      const normalized = normalizeConfigPaths(input);

      expect(normalized).toBe(input);
      expect(normalized.plugins?.entries?.demo?.config).toBe(untouched);
    });
  });
});
