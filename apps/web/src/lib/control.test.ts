import { afterEach, describe, expect, it, vi } from "vitest";
import { sendControl } from "./control.js";

describe("control request failures", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports an empty proxy error without exposing a JSON parser exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(sendControl("/api/prompts", "POST", {})).rejects.toThrow("Request failed (500). Please retry.");
  });
  it("preserves useful validation errors from the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Pause the team before editing" } }, { status: 409 })));
    await expect(sendControl("/api/agents/id", "PATCH", {})).rejects.toThrow("Pause the team before editing");
  });
});
