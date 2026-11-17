# Codex provider isolation status

**Status: disabled.** The current CLI does not demonstrate the isolation required for automated trading decisions. The adapter refuses every decision request; it cannot execute a model call until the capability gate can prove the required controls.

## Verified CLI

Inspected on November 17, 2026:

- `codex-cli 0.167.0-alpha.3.2`
- `codex exec --help` exposes `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--json`, `--output-schema`, and `--sandbox read-only`.
- The official [non-interactive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode) describes `--sandbox read-only` as a filesystem/command sandbox and documents loading project configuration and project MCP servers for trusted projects.
- The official [CLI command reference](https://learn.chatgpt.com/docs/developer-commands) lists those flags but no option to remove built-in command execution or all other tools.
- `--ignore-user-config` retains the authentication location. The adapter does not inspect, copy, or edit authentication files.

These flags can isolate configuration sources and restrict filesystem writes. They do not prove that model-invoked commands, plugins, hooks, connectors, or other tools are unavailable. Read-only execution still permits commands, so it is insufficient for this application. No model call or canary that could inspect host data was run.

## Capability gate

`checkCodexCapabilities()` inspects CLI help in a fresh temporary working directory and removes that directory afterward. It reports unavailable unless required flags and a command-tool disable control are present. `CodexDecisionProvider.decide()` always rejects while the gate is unavailable. The provider must remain disabled until a supported CLI can prove command execution, plugins, hooks, connectors/MCP, and all other tools are unavailable while retaining existing authentication.
