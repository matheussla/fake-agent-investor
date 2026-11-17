import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexDecisionProvider, checkCodexCapabilities } from "./codex.js";

const fixtures: string[] = [];
async function fakeCli(output: string) {
  const directory = await mkdtemp(join(tmpdir(), "codex-cli-fixture-"));
  fixtures.push(directory);
  const cli = join(directory, "codex");
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
  await chmod(cli, 0o700);
  return cli;
}

afterEach(async () => { await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Codex isolation gate", () => {
  it("keeps the provider disabled when CLI help lacks a tool isolation control", async () => {
    const cli = await fakeCli("--ignore-user-config --ignore-rules --ephemeral --output-schema --json --sandbox read-only");
    expect(await checkCodexCapabilities(cli)).toMatchObject({ status: "unavailable", detail: expect.stringContaining("command tool isolation cannot be demonstrated") });
    await expect(new CodexDecisionProvider().decide()).rejects.toThrow("provider is disabled");
  });

  it("reports a missing CLI without revealing environment data", async () => {
    expect(await checkCodexCapabilities("/missing/codex-cli")).toMatchObject({ status: "unavailable", detail: "Codex CLI capability check failed; provider remains disabled" });
  });
});
