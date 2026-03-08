import { describe, expect, it } from "vitest";
import { validateProviderConfig, ProviderConfigError } from "../langgraph/config";

describe("validateProviderConfig", () => {
  it("throws ProviderConfigError for missing apiKey (openai/anthropic/gemini/azure-openai/openai-compatible)", () => {
    const configs = [
      { type: "openai", model: "gpt-4o-mini" },
      { type: "anthropic", model: "claude-3-5-sonnet-latest" },
      { type: "gemini", model: "gemini-2.0-flash" },
      {
        type: "azure-openai",
        model: "gpt-4o-mini",
        azureOpenAIApiDeploymentName: "deploy",
        azureOpenAIApiInstanceName: "instance",
        azureOpenAIApiVersion: "2024-06-01",
      },
      { type: "openai-compatible", model: "llama-3.1-70b" },
    ];

    for (const config of configs) {
      expect(() => validateProviderConfig(config as any)).toThrow(ProviderConfigError);
    }
  });

  it("throws for missing azureOpenAIApiDeploymentName on azure-openai", () => {
    expect(() =>
      validateProviderConfig({
        type: "azure-openai",
        model: "gpt-4o-mini",
        apiKey: "test",
        azureOpenAIApiDeploymentName: "",
        azureOpenAIApiInstanceName: "instance",
        azureOpenAIApiVersion: "2024-06-01",
      })
    ).toThrow(ProviderConfigError);
  });

  it("passes for valid ollama config (no apiKey needed)", () => {
    expect(() =>
      validateProviderConfig({
        type: "ollama",
        model: "llama3.1",
      })
    ).not.toThrow();
  });

  it("throws for invalid temperature range", () => {
    expect(() =>
      validateProviderConfig({
        type: "openai",
        model: "gpt-4o-mini",
        apiKey: "test",
        temperature: 2.5,
      })
    ).toThrow(ProviderConfigError);
  });
});
