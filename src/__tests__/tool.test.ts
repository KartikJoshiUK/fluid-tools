import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { Tools } from "../langgraph/tool";

const toolA = new DynamicStructuredTool({
  name: "tool_a",
  description: "Tool A",
  schema: z.object({}),
  func: async () => "ok",
});

const toolB = new DynamicStructuredTool({
  name: "tool_b",
  description: "Tool B",
  schema: z.object({}),
  func: async () => "ok",
});

describe("Tools", () => {
  it("withFilter(names) returns new Tools instance, original unchanged", () => {
    const base = new Tools({ tool_a: toolA, tool_b: toolB });
    const filtered = base.withFilter(["tool_a"]);

    expect(base).not.toBe(filtered);
    expect(Object.keys(base.getToolByName())).toEqual(["tool_a", "tool_b"]);
    expect(Object.keys(filtered.getToolByName())).toEqual(["tool_a"]);
  });

  it("getToolByName() with filter returns only matching tools", () => {
    const tools = new Tools({ tool_a: toolA, tool_b: toolB }).withFilter(["tool_b"]);
    expect(Object.keys(tools.getToolByName())).toEqual(["tool_b"]);
  });

  it("getToolByName() with empty filter match falls back to all tools", () => {
    const tools = new Tools({ tool_a: toolA, tool_b: toolB }).withFilter(["missing_tool"]);
    expect(Object.keys(tools.getToolByName())).toEqual(["tool_a", "tool_b"]);
  });
});
