// Configuration types and validation

import { ProviderConfig } from './types';

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function validateProviderConfig(config: ProviderConfig): void {
  // Validate common fields
  if (!config.type) {
    throw new ProviderConfigError("Provider type is required");
  }

  if (!config.model) {
    throw new ProviderConfigError("Model name is required");
  }

  // Validate provider-specific requirements
  switch (config.type) {
    case "ollama":
      // Ollama only requires type and model, baseUrl is optional
      if (config.baseUrl && typeof config.baseUrl !== "string") {
        throw new ProviderConfigError("Ollama baseUrl must be a string");
      }
      break;

    case "openai":
      if (!config.apiKey) {
        throw new ProviderConfigError("OpenAI API key is required");
      }
      if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
        throw new ProviderConfigError(
          "OpenAI API key must be a non-empty string"
        );
      }
      if (
        config.temperature !== undefined &&
        (typeof config.temperature !== "number" ||
          config.temperature < 0 ||
          config.temperature > 2)
      ) {
        throw new ProviderConfigError(
          "OpenAI temperature must be a number between 0 and 2"
        );
      }
      break;

    case "azure-openai":
      if (!config.apiKey) {
        throw new ProviderConfigError("Azure OpenAI API key is required");
      }
      if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
        throw new ProviderConfigError(
          "Azure OpenAI API key must be a non-empty string"
        );
      }
      if (!config.azureOpenAIApiDeploymentName) {
        throw new ProviderConfigError(
          "Azure OpenAI deployment name is required"
        );
      }
      if (!config.azureOpenAIApiInstanceName) {
        throw new ProviderConfigError(
          "Azure OpenAI instance name is required"
        );
      }
      if (!config.azureOpenAIApiVersion) {
        throw new ProviderConfigError("Azure OpenAI API version is required");
      }
      break;

    case "anthropic":
      if (!config.apiKey) {
        throw new ProviderConfigError("Anthropic API key is required");
      }
      if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
        throw new ProviderConfigError(
          "Anthropic API key must be a non-empty string"
        );
      }
      if (
        config.temperature !== undefined &&
        (typeof config.temperature !== "number" ||
          config.temperature < 0 ||
          config.temperature > 1)
      ) {
        throw new ProviderConfigError(
          "Anthropic temperature must be a number between 0 and 1"
        );
      }
      break;

    case "gemini":
      if (!config.apiKey) {
        throw new ProviderConfigError("Gemini API key is required");
      }
      if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
        throw new ProviderConfigError(
          "Gemini API key must be a non-empty string"
        );
      }
      break;

    case "openai-compatible":
      if (!config.apiKey) {
        throw new ProviderConfigError(
          "OpenAI-compatible provider API key is required"
        );
      }
      if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
        throw new ProviderConfigError(
          "OpenAI-compatible provider API key must be a non-empty string"
        );
      }
      if (config.baseUrl && typeof config.baseUrl !== "string") {
        throw new ProviderConfigError(
          "OpenAI-compatible provider baseUrl must be a string"
        );
      }
      break;

    default:
      // Exhaustiveness guard for future provider additions.
      const exhaustiveCheck: never = config;
      throw new ProviderConfigError(
        `Unsupported provider type: ${String(exhaustiveCheck)}`
      );
  }
}
