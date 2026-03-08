import FluidToolsClient from './client/index.js';
import { Tools } from './langgraph/tool.js';
import type { ToolDictionary, ToolFactory } from './langgraph/tool.js';
import { ProviderConfigError } from './langgraph/config.js';
import { ensureProviderInstalled } from './langgraph/factory.js';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

// LangGraph types
import type {
  AnthropicConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  OpenAICompatibleConfig,
  OllamaConfig,
  OpenAIConfig,
  ProviderConfig,
  ProviderType,           
  BaseProviderConfig,     
  Model,                  
  ToolConfirmationConfig, 
  PendingToolCall,        
  FluidStreamEvent,
  StreamEventType,
  FluidQueryResult,
  FluidQueryError,
  FluidErrorCode,
} from './langgraph/types.js';
import type {
  EmbeddingConfig,
  FluidToolsClientOptions,
  SessionConfig,
  ToolExecutionConfig,
} from './client/index.js';
import type { HeaderResolver } from './types/header.types.js';
import type { RetryConfig } from './converters/retry.types.js';
import type { ContentFilter } from './types/filter.types.js';
import type { RateLimitConfig } from './types/ratelimit.types.js';

// Converter types
import type {
  PostmanCollection,
  PostmanDescriptionObject, 
  PostmanDescription,       
  PostmanQueryParam,        
  PostmanUrlObject,         
  PostmanUrl,              
  PostmanBodyField,        
  PostmanBody,             
  PostmanRequestDetail,    
  PostmanItem,             
  PostmanCollectionInfo,   
  PostmanRequest,          
} from './converters/types.js';
import { openApiToTools } from './converters/openapi-to-tools.js';
import {
  DEFAULT_EMBEDDING_MAX_CACHE_ENTRIES,
  DEFAULT_EMBEDDING_MIN_TOOLS,
  DEFAULT_EMBEDDING_TOP_K,
  DEFAULT_MAX_TOOL_RESPONSE_BYTES,
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
} from './constants/runtime.constants.js';
import type {
  OpenAPISpec,
  OpenAPIPathItem,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPISchema,
} from './converters/openapi.types.js';

// RAG types
import type {
  RAGConfig,
  RAGDocument,
  RAGProvider,
  RAGSearchOptions,        
  RAGDecision,            
  RAGEnhancementResult,   
} from './types/rag.types.js';

// Query types (ALL NEW)
import type {
  QueryLog,
  QueryMetadata,
  QueryProvider,
  QueryConfig,
} from './types/query.types.js';

export {
  Tools,
  ProviderConfigError,
  ensureProviderInstalled,
  openApiToTools,
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_RESPONSE_BYTES,
  DEFAULT_EMBEDDING_TOP_K,
  DEFAULT_EMBEDDING_MIN_TOOLS,
  DEFAULT_EMBEDDING_MAX_CACHE_ENTRIES,
};
export type { Tool as EmbeddingTool, SearchResult } from './embeddings/client.js';

export type {
  ProviderConfig,
  AnthropicConfig,
  OllamaConfig,
  GeminiConfig,
  AzureOpenAIConfig,
  OpenAICompatibleConfig,
  OpenAIConfig,
  ProviderType,
  BaseProviderConfig,
  Model,
  ToolConfirmationConfig,
  PendingToolCall,
  FluidStreamEvent,
  StreamEventType,
  FluidQueryResult,
  FluidQueryError,
  FluidErrorCode,
  FluidToolsClientOptions,
  HeaderResolver,
  EmbeddingConfig,
  SessionConfig,
  ToolExecutionConfig,
  BaseCheckpointSaver,
  PostmanCollection,
  PostmanDescriptionObject,
  PostmanDescription,
  PostmanQueryParam,
  PostmanUrlObject,
  PostmanUrl,
  PostmanBodyField,
  PostmanBody,
  PostmanRequestDetail,
  PostmanItem,
  PostmanCollectionInfo,
  PostmanRequest,
  OpenAPISpec,
  OpenAPIPathItem,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPISchema,
  RAGProvider,
  RAGDocument,
  RAGConfig,
  RAGSearchOptions,
  RAGDecision,
  RAGEnhancementResult,
  QueryLog,
  QueryMetadata,
  QueryProvider,
  QueryConfig,
  RetryConfig,
  ContentFilter,
  RateLimitConfig,
  ToolDictionary,
  ToolFactory,
};

export { default as FluidToolsClient } from './client/index.js';
export default FluidToolsClient;