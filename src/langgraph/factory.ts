// Main factory function

import { ProviderConfigError, validateProviderConfig } from './config';
import type { Model, ProviderConfig } from './types';

/**
 * Helper to lazily load a concrete LangChain model the first time it is used.
 *
 * This lets optional providers (ollama, anthropic, gemini) remain truly optional:
 * we only attempt to import their packages if the caller actually chooses that provider type.
 */
function createLazyModel(loader: () => Promise<Model>): Model {
  let innerPromise:
    | Promise<Model>
    | null = null;

  async function getInner() {
    if (!innerPromise) {
      innerPromise = loader();
    }
    return innerPromise;
  }

  return {
    async invoke(input) {
      const model = await getInner();
      return model.invoke(input);
    },
    bindTools(tools) {
      return {
        async invoke(input) {
          const model = await getInner();
          const withTools = model.bindTools(tools);
          return withTools.invoke(input);
        },
      };
    },
  };
}

/**
 * Eager, side-effect-free check that the underlying model package
 * for a given provider type is actually installed.
 *
 * This is intended for application startup health checks:
 * call it once with your ProviderConfig to fail fast if a
 * required provider package is missing, without making a real LLM call.
 */
export async function ensureProviderInstalled(config: ProviderConfig): Promise<void> {
  switch (config.type) {
    case "ollama":
      try {
        await import("@langchain/ollama");
      } catch (error) {
        throw new ProviderConfigError(
          `Failed to load Ollama provider. Make sure '@langchain/ollama' is installed in your project. Original error: ${(error as Error).message}`
        );
      }
      return;

    case "openai":
    case "azure-openai":
    case "openai-compatible":
      try {
        await import("@langchain/openai");
      } catch (error) {
        throw new ProviderConfigError(
          `Failed to load OpenAI provider. Make sure '@langchain/openai' is installed in your project. Original error: ${(error as Error).message}`
        );
      }
      return;

    case "anthropic":
      try {
        await import("@langchain/anthropic");
      } catch (error) {
        throw new ProviderConfigError(
          `Failed to load Anthropic provider. Make sure '@langchain/anthropic' is installed in your project. Original error: ${(error as Error).message}`
        );
      }
      return;

    case "gemini":
      try {
        await import("@langchain/google-genai");
      } catch (error) {
        throw new ProviderConfigError(
          `Failed to load Gemini provider. Make sure '@langchain/google-genai' is installed in your project. Original error: ${(error as Error).message}`
        );
      }
      return;

    default:
      return;
  }
}

export function createProvider(config: ProviderConfig): Model {
  validateProviderConfig(config);

  switch (config.type) {
    case "ollama":
      return createLazyModel(async () => {
        try {
          const { ChatOllama } = await import("@langchain/ollama");
          return new ChatOllama({
            model: config.model,
            baseUrl: config.baseUrl || "http://localhost:11434",
            temperature: config.temperature,
            numCtx: config.numCtx,
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load Ollama provider. Make sure '@langchain/ollama' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    case "openai":
      return createLazyModel(async () => {
        try {
          const { ChatOpenAI } = await import("@langchain/openai");
          return new ChatOpenAI({
            model: config.model,
            openAIApiKey: config.apiKey,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            topP: config.topP,
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load OpenAI provider. Make sure '@langchain/openai' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    case "azure-openai":
      return createLazyModel(async () => {
        try {
          const { AzureChatOpenAI } = await import("@langchain/openai");
          return new AzureChatOpenAI({
            model: config.model,
            azureOpenAIApiKey: config.apiKey,
            azureOpenAIApiDeploymentName: config.azureOpenAIApiDeploymentName,
            azureOpenAIApiInstanceName: config.azureOpenAIApiInstanceName,
            azureOpenAIApiVersion: config.azureOpenAIApiVersion,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            topP: config.topP,
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load Azure OpenAI provider. Make sure '@langchain/openai' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    case "anthropic":
      return createLazyModel(async () => {
        try {
          const { ChatAnthropic } = await import("@langchain/anthropic");
          return new ChatAnthropic({
            model: config.model,
            anthropicApiKey: config.apiKey,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            topP: config.topP,
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load Anthropic provider. Make sure '@langchain/anthropic' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    case "gemini":
      return createLazyModel(async () => {
        try {
          const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
          return new ChatGoogleGenerativeAI({
            model: config.model,
            apiKey: config.apiKey,
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            topP: config.topP,
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load Gemini provider. Make sure '@langchain/google-genai' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    case "openai-compatible":
      return createLazyModel(async () => {
        try {
          const { ChatOpenAI } = await import("@langchain/openai");
          return new ChatOpenAI({
            model: config.model,
            apiKey: config.apiKey,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            topP: config.topP,
            configuration: {
              baseURL: config.baseUrl,
            },
          });
        } catch (error) {
          throw new ProviderConfigError(
            `Failed to load OpenAI-compatible provider. Make sure '@langchain/openai' is installed in your project. Original error: ${(error as Error).message}`
          );
        }
      });

    default:
      // Exhaustiveness guard for future provider additions.
      const exhaustiveCheck: never = config;
      throw new Error(`Unsupported provider type: ${String(exhaustiveCheck)}`);
  }
}
