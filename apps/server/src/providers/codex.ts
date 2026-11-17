import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { DecisionProvider, DecisionResult, ProviderHealth } from "@paper-investor/contracts";

const execFile = promisify(execFileCallback);
const requiredFlags = ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema", "--json", "--sandbox"];

export class CodexDecisionProvider implements DecisionProvider {
  async decide(): Promise<DecisionResult> {
    throw new Error("Codex decision provider is disabled: tool isolation is not supported by the installed CLI");
  }
}

export async function checkCodexCapabilities(binary = "codex"): Promise<ProviderHealth> {
  const directory = await mkdtemp(`${tmpdir()}/paper-codex-capability-`);
  try {
    const result = await execFile(binary, ["exec", "--help"], {
      cwd: directory,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) },
    });
    const help = `${result.stdout}\n${result.stderr}`;
    const availableFlags = requiredFlags.filter((flag) => help.includes(flag));
    const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
    const removesCommandTool = /--disable[^\n]*(?:exec|command)|tools\.[^\n]*(?:disabled|false)/i.test(help);
    if (missingFlags.length === 0 && removesCommandTool) return { status: "healthy", detail: "Required CLI flags and command isolation control are available" };
    return { status: "unavailable", detail: `Codex decision provider disabled: command tool isolation cannot be demonstrated (CLI ${missingFlags.length ? `missing ${missingFlags.join(", ")}; ` : ""}has no supported command-tool disable control; detected ${availableFlags.join(", ")})` };
  } catch {
    return { status: "unavailable", detail: "Codex CLI capability check failed; provider remains disabled" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
