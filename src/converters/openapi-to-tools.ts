import { AxiosInstance, isAxiosError } from "axios";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  OpenAPIParameter,
  OpenAPISchema,
  OpenAPISpec,
  OpenAPIOperation,
} from "./openapi.types";
import { HeaderResolver } from "../types/header.types";
import { RetryConfig } from "./retry.types";
import {
  DEFAULT_MAX_TOOL_RESPONSE_BYTES,
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
} from "../constants/runtime.constants";

type ToolDictionary = Record<string, DynamicStructuredTool>;

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete", "head"];

function resolveRef(schema: OpenAPISchema, spec: OpenAPISpec): OpenAPISchema {
  if (!schema.$ref) return schema;
  const refPrefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(refPrefix)) return schema;
  const key = schema.$ref.slice(refPrefix.length);
  return spec.components?.schemas?.[key] ?? schema;
}

function truncateToolResponse(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return content;
  }
  const suffix = "\n\n...[response truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const truncated = encoded.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8");
  return `${truncated}${suffix}`;
}

function inferZodFromOpenApiSchema(schema: OpenAPISchema | undefined, spec: OpenAPISpec): z.ZodType<unknown> {
  if (!schema) return z.unknown();
  const resolved = resolveRef(schema, spec);

  if (Array.isArray(resolved.allOf) && resolved.allOf.length > 0) {
    const mergedProperties: Record<string, OpenAPISchema> = {};
    const mergedRequired = new Set<string>();
    for (const subSchema of resolved.allOf) {
      const subResolved = resolveRef(subSchema, spec);
      Object.assign(mergedProperties, subResolved.properties ?? {});
      for (const key of subResolved.required ?? []) {
        mergedRequired.add(key);
      }
    }
    return inferZodFromOpenApiSchema(
      {
        ...resolved,
        type: "object",
        properties: mergedProperties,
        required: [...mergedRequired],
      },
      spec
    );
  }

  if (Array.isArray(resolved.anyOf) && resolved.anyOf.length > 0) {
    console.warn("[openApiToTools] anyOf schemas are treated as z.unknown().");
  }
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.length > 0) {
    console.warn("[openApiToTools] oneOf schemas are treated as z.unknown().");
  }

  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    return z.enum(resolved.enum.map((value) => String(value)) as [string, ...string[]]);
  }

  switch (resolved.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(inferZodFromOpenApiSchema(resolved.items, spec));
    case "object": {
      const shape: Record<string, z.ZodType<unknown>> = {};
      const required = new Set(resolved.required ?? []);
      for (const [key, value] of Object.entries(resolved.properties ?? {})) {
        const field = inferZodFromOpenApiSchema(value, spec);
        shape[key] = required.has(key) ? field : field.optional();
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

function buildOperationName(method: HttpMethod, path: string, operation: OpenAPIOperation): string {
  if (operation.operationId && operation.operationId.trim().length > 0) {
    return operation.operationId.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  }
  return `${method}_${path.replace(/\//g, "_").replace(/[{}]/g, "")}`
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_/, "");
}

function buildDescription(method: HttpMethod, path: string, operation: OpenAPIOperation): string {
  return operation.summary ?? operation.description ?? `Performs ${method.toUpperCase()} ${path}`;
}

function buildSchema(parameters: OpenAPIParameter[], bodySchema: OpenAPISchema | undefined, spec: OpenAPISpec) {
  const shape: Record<string, z.ZodType<unknown>> = {};

  for (const parameter of parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const inferred = inferZodFromOpenApiSchema(parameter.schema, spec);
    shape[parameter.name] = parameter.required
      ? inferred.describe(parameter.description ?? `${parameter.name} parameter`)
      : inferred.optional().describe(parameter.description ?? `${parameter.name} parameter`);
  }

  if (bodySchema) {
    shape.body = inferZodFromOpenApiSchema(bodySchema, spec).optional().describe("Request body");
  }

  // Allow runtime-injected non-schema fields (e.g. authToken from toolNode)
  // without advertising them to the model.
  return z.object(shape).loose();
}

function applyPathParams(path: string, args: Record<string, unknown>, parameters: OpenAPIParameter[]): string {
  let updatedPath = path;
  for (const parameter of parameters) {
    if (parameter.in !== "path") continue;
    const value = args[parameter.name];
    if (value === undefined || value === null) continue;
    updatedPath = updatedPath.replace(
      new RegExp(`{${parameter.name}}`, "g"),
      encodeURIComponent(String(value))
    );
  }
  return updatedPath;
}

function joinBaseAndPath(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function openApiToTools(
  spec: OpenAPISpec,
  axiosInstance: AxiosInstance,
  toolsConfig: Record<string, string> = {},
  retryConfig: RetryConfig = {},
  headerResolver?: HeaderResolver,
  debug: boolean = false
): ToolDictionary {
  const tools: ToolDictionary = {};
  const usedNames = new Set<string>();
  const parsedTimeout = Number(toolsConfig.REQUEST_TIMEOUT_MS);
  const timeout =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_TOOL_REQUEST_TIMEOUT_MS;
  const parsedMaxToolResponseBytes = Number(toolsConfig.MAX_TOOL_RESPONSE_BYTES);
  const maxToolResponseBytes =
    Number.isFinite(parsedMaxToolResponseBytes) && parsedMaxToolResponseBytes > 0
      ? parsedMaxToolResponseBytes
      : DEFAULT_MAX_TOOL_RESPONSE_BYTES;
  const maxRetries = retryConfig.maxRetries ?? 3;
  const retryDelayMs = retryConfig.retryDelayMs ?? 500;
  const retryOnStatusCodes = new Set(retryConfig.retryOnStatusCodes ?? [429, 500, 502, 503, 504]);
  const baseUrl = spec.servers?.[0]?.url ?? toolsConfig.BASE_URL ?? "";
  const defaultHeaderResolver: HeaderResolver = (
    _toolName: string,
    accessToken: string | undefined
  ) => {
    const headers: Record<string, string> = {};
    if (accessToken && accessToken.length > 0) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  };
  const resolvedHeaderResolver: HeaderResolver = headerResolver ?? defaultHeaderResolver;

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const rawName = buildOperationName(method, path, operation);
      let name = rawName;
      let suffix = 1;
      while (usedNames.has(name)) {
        name = `${rawName}_${suffix}`;
        suffix += 1;
      }
      if (name !== rawName) {
        console.warn(
          `[openApiToTools] Tool name collision detected: '${rawName}' renamed to '${name}'.`
        );
      }
      usedNames.add(name);

      const parameters = operation.parameters ?? [];
      const jsonBodySchema = operation.requestBody?.content?.["application/json"]?.schema;
      const schema = buildSchema(parameters, jsonBodySchema, spec);
      const description = buildDescription(method, path, operation);

      tools[name] = new DynamicStructuredTool({
        name,
        description,
        schema,
        func: async (toolArgs: Record<string, unknown>) => {
          const args = toolArgs ?? {};
          const params: Record<string, string> = {};
          for (const parameter of parameters) {
            if (parameter.in !== "query") continue;
            const value = args[parameter.name];
            if (value !== undefined && value !== null) {
              params[parameter.name] = String(value);
            }
          }

          const authToken = typeof args.authToken === "string" ? args.authToken : undefined;
          const headers = resolvedHeaderResolver(name, authToken);
          const resolvedPath = applyPathParams(path, args, parameters);
          const url = joinBaseAndPath(baseUrl, resolvedPath);
          const body = args.body && typeof args.body === "object" ? args.body : undefined;

          if (debug) {
            const redactedBody =
              body && typeof body === "object"
                ? Object.fromEntries(
                    Object.keys(body as Record<string, unknown>).map((key) => [key, "[REDACTED]"])
                  )
                : undefined;
            console.log(
              "[openApiToTools] Request",
              JSON.stringify(
                {
                  method: method.toUpperCase(),
                  url,
                  params: Object.keys(params),
                  body: redactedBody,
                },
                null,
                2
              )
            );
          }

          try {
            const requestConfig = {
              method: method.toUpperCase(),
              url,
              params,
              data: body,
              headers,
              timeout,
            };
            let responseData: unknown;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                const response = await axiosInstance.request(requestConfig);
                responseData = response.data;
                break;
              } catch (retryError: unknown) {
                if (!isAxiosError(retryError)) {
                  throw retryError;
                }

                const status = retryError.response?.status;
                const isRetryableStatus =
                  typeof status === "number" && retryOnStatusCodes.has(status);
                const isRetryableNetworkError =
                  !retryError.response &&
                  (retryError.code === "ECONNABORTED" || retryError.code === "ECONNRESET");
                const shouldRetry =
                  (isRetryableStatus || isRetryableNetworkError) && attempt < maxRetries;

                if (!shouldRetry) {
                  throw retryError;
                }

                const delay = retryDelayMs * (2 ** attempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }
            return truncateToolResponse(JSON.stringify(responseData, null, 2), maxToolResponseBytes);
          } catch (error: unknown) {
            if (
              isAxiosError(error) &&
              (error.code === "ECONNABORTED" || error.message.toLowerCase().includes("timeout"))
            ) {
              return `Error: Request timed out after ${timeout}ms`;
            }
            if (isAxiosError(error) && error.response) {
              if (debug) {
                console.error("[openApiToTools] Tool request failed", {
                  toolName: name,
                  status: error.response.status,
                  responseBody: "[REDACTED]",
                  message: error.message,
                });
              }
              return `Error calling ${name}: HTTP ${error.response.status}`;
            }
            if (error instanceof Error) {
              return `Error: ${error.message}`;
            }
            return "Error: Unknown error";
          }
        },
      });
    }
  }

  return tools;
}
