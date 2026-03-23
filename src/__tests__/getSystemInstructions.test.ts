import { describe, expect, it } from "vitest";
import FluidToolsClient from "../client";

function createClient(systemInstructions?: string) {
  return new FluidToolsClient({
    config: {
      type: "ollama",
      model: "llama3.1",
    },
    postmanCollection: { item: [] },
    maxToolCalls: 7,
    systemInstructions,
  });
}

describe("getSystemInstructions", () => {
  it("{date} is substituted in the output", () => {
    const client = createClient();
    const output = (client as any).getSystemInstructions() as string;
    expect(output).not.toContain("{date}");
  });

  it("{max_tool_calls} is substituted", () => {
    const client = createClient();
    const output = (client as any).getSystemInstructions() as string;
    expect(output).toContain("maximum of 7 tool calls");
    expect(output).not.toContain("{max_tool_calls}");
  });

  it("{tool_count} is substituted", () => {
    const client = createClient();
    const output = (client as any).getSystemInstructions() as string;
    expect(output).toContain("Available tools: 0");
    expect(output).not.toContain("{tool_count}");
  });

  it("Custom systemInstructions appended inside <Additional Instructions> tags", () => {
    const client = createClient("Only call billing tools for payment requests.");
    const output = (client as any).getSystemInstructions() as string;
    expect(output).toContain("<Additional Instructions>");
    expect(output).toContain("Only call billing tools for payment requests.");
    expect(output).toContain("</Additional Instructions>");
  });
});
