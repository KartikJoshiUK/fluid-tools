import { describe, expect, it, vi } from "vitest";
import FluidToolsClient from "../client";

describe("FluidToolsClient query result handling", () => {
  function createClient() {
    return new FluidToolsClient({
      config: {
        type: "ollama",
        model: "llama3.1",
      },
      postmanCollection: { item: [] },
    });
  }

  it("returns RATE_LIMITED error when query limit exceeded", async () => {
    const client = new FluidToolsClient({
      config: {
        type: "ollama",
        model: "llama3.1",
      },
      postmanCollection: { item: [] },
      rateLimitConfig: {
        maxQueriesPerWindow: 1,
        windowMs: 60_000,
      },
    });

    (client as any).fluidTool = {
      query: vi.fn().mockResolvedValue({ messages: [{ content: "ok" }] }),
      getPendingConfirmations: vi.fn().mockResolvedValue([]),
    };

    const first = await client.query("one", "token-rate");
    const second = await client.query("two", "token-rate");

    expect(first.status).toBe("success");
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.error.code).toBe("RATE_LIMITED");
      expect(second.error.retryable).toBe(true);
    }
  });

  it("returns structured error on LLM failure", async () => {
    const client = createClient();
    (client as any).fluidTool = {
      query: vi.fn().mockRejectedValue(new Error("LLM provider failed")),
      getPendingConfirmations: vi.fn().mockResolvedValue([]),
    };

    const result = await client.query("hello", "token-llm");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("LLM_ERROR");
    }
  });
});
