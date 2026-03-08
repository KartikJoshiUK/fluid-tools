import { AxiosInstance, isAxiosError } from "axios";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  PostmanCollection,
  PostmanDescription,
  PostmanItem,
  PostmanRequest,
  PostmanUrl,
  PostmanUrlObject,
} from './types';
import { HeaderResolver } from "../types/header.types";
import { RetryConfig } from "./retry.types";
import {
  DEFAULT_MAX_TOOL_RESPONSE_BYTES,
  DEFAULT_TOOL_REQUEST_TIMEOUT_MS,
} from "../constants/runtime.constants";

type ToolDictionary = Record<string, DynamicStructuredTool>;

interface QueryOrPathParam {
  key: string;
  description: string;
}

interface BodyField {
  key: string;
  schema: z.ZodType<unknown>;
  description: string;
}

const FILE_FIELD_SCHEMA = z
  .union([z.string(), z.instanceof(Buffer), z.unknown()])
  .optional();

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

function isPostmanUrlObject(url: PostmanUrl): url is PostmanUrlObject {
  return typeof url === "object" && url !== null && "raw" in url;
}

function getRawUrl(url: PostmanUrl): string {
  if (typeof url === "string") {
    return url;
  }
  return url.raw ?? "";
}

function flattenPostmanCollection(collection: PostmanCollection): PostmanRequest[] {
  const requests: PostmanRequest[] = [];

  const visit = (items: PostmanItem[]): void => {
    for (const item of items) {
      if (item.request) {
        requests.push({ name: item.name, request: item.request });
      }
      if (Array.isArray(item.item) && item.item.length > 0) {
        visit(item.item);
      }
    }
  };

  visit(collection.item ?? []);
  return requests;
}

function toDescriptionText(description?: PostmanDescription): string {
  if (typeof description === "string") {
    return description;
  }
  if (description && typeof description.content === "string") {
    return description.content;
  }
  return "";
}

function extractQueryParams(request: PostmanRequest): QueryOrPathParam[] {
  const queryParams: QueryOrPathParam[] = [];
  const { url } = request.request;

  if (isPostmanUrlObject(url) && Array.isArray(url.query)) {
    for (const queryParam of url.query) {
      queryParams.push({
        key: queryParam.key,
        description: queryParam.description ?? `${queryParam.key} parameter`,
      });
    }
    return queryParams;
  }

  const raw = getRawUrl(url);
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) {
    return queryParams;
  }

  const parsed = new URLSearchParams(raw.slice(queryStart + 1));
  for (const [key] of parsed) {
    queryParams.push({
      key,
      description: `${key} parameter`,
    });
  }

  return queryParams;
}

function extractPathParams(request: PostmanRequest): QueryOrPathParam[] {
  const pathParams: QueryOrPathParam[] = [];
  const { url } = request.request;
  const raw = getRawUrl(url);
  const pathOnly = raw.replace(/^[a-zA-Z]+:\/\/[^/]+/, "");

  const addParam = (key: string): void => {
    if (!pathParams.some((param) => param.key === key)) {
      pathParams.push({
        key,
        description: `${key} path parameter`,
      });
    }
  };

  for (const match of pathOnly.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    addParam(match[1]);
  }

  for (const match of raw.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)) {
    addParam(match[1]);
  }

  for (const match of raw.matchAll(/{([A-Za-z0-9_]+)}/g)) {
    addParam(match[1]);
  }

  if (isPostmanUrlObject(url) && Array.isArray(url.path)) {
    for (const segment of url.path) {
      const segmentMatch = segment.match(/^:([A-Za-z0-9_]+)$/);
      if (segmentMatch?.[1]) {
        addParam(segmentMatch[1]);
      }
    }
  }

  return pathParams;
}

function inferZodSchema(value: unknown): z.ZodType<unknown> {
  if (value === null) {
    return z.null();
  }
  if (typeof value === "string") {
    return z.string();
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? z.number().int() : z.number();
  }
  if (typeof value === "boolean") {
    return z.boolean();
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return z.array(z.unknown());
    }
    return z.array(inferZodSchema(value[0]));
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const shape: Record<string, z.ZodType<unknown>> = {};
    for (const [key, nested] of Object.entries(objectValue)) {
      shape[key] = inferZodSchema(nested).optional();
    }
    return z.object(shape);
  }
  return z.unknown();
}

function extractBodyFields(request: PostmanRequest): BodyField[] {
  const bodyFields: BodyField[] = [];
  const body = request.request.body;
  if (!body) {
    return bodyFields;
  }

  if (body.mode === "raw" && typeof body.raw === "string") {
    try {
      const parsed = JSON.parse(body.raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          bodyFields.push({
            key,
            schema: inferZodSchema(value),
            description: `${key} field`,
          });
        }
      }
    } catch {
      return bodyFields;
    }
  }

  if (body.mode === "urlencoded" && Array.isArray(body.urlencoded)) {
    for (const field of body.urlencoded) {
      bodyFields.push({
        key: field.key,
        schema: z.string(),
        description: field.description ?? `${field.key} field`,
      });
    }
  }

  if (body.mode === "formdata" && Array.isArray(body.formdata)) {
    for (const field of body.formdata) {
      bodyFields.push({
        key: field.key,
        schema: field.type === "file" ? FILE_FIELD_SCHEMA : z.string(),
        description:
          field.description ?? `${field.key} ${field.type === "file" ? "(file)" : "field"}`,
      });
    }
  }

  return bodyFields;
}

function generateToolName(request: PostmanRequest, method: string, url: string): string {
  const requestName = request.name?.trim();
  if (requestName && !requestName.toLowerCase().includes("new request")) {
    return requestName
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[0-9]/, "_$&")
      .toLowerCase();
  }

  const pathMatch = url.match(/\/([^/?]+)(?:\/[^/?]*)?$/);
  const resource = pathMatch?.[1] ?? "api";
  return `${method.toLowerCase()}_${resource}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

function generateDescription(request: PostmanRequest): string {
  const method = request.request.method.toUpperCase();
  const url = getRawUrl(request.request.url);
  const providedDescription = toDescriptionText(request.request.description).trim();

  if (providedDescription.length > 0) {
    return providedDescription;
  }

  const pathMatch = url.match(/\/([^/?]+)(?:\?|$)/);
  const resource = (pathMatch?.[1] ?? "resource").replace(/-/g, " ");

  switch (method) {
    case "GET":
      return `Retrieves information about ${resource}. Endpoint: ${method} ${url}`;
    case "POST":
      return `Creates a new ${resource}. Endpoint: ${method} ${url}`;
    case "PUT":
    case "PATCH":
      return `Updates an existing ${resource}. Endpoint: ${method} ${url}`;
    case "DELETE":
      return `Deletes a ${resource}. Endpoint: ${method} ${url}`;
    default:
      return `Performs an operation on ${resource}. Endpoint: ${method} ${url}`;
  }
}

function normalizeUrl(url: string, baseUrl: string): string {
  const resolved = url
    .replace(/{{\s*BASE_URL\s*}}/gi, baseUrl)
    .replace(/^{{\s*base_url\s*}}/i, baseUrl);

  if (/^https?:\/\//i.test(resolved)) {
    return resolved;
  }

  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = resolved.startsWith("/") ? resolved : `/${resolved}`;
  return `${normalizedBase}${normalizedPath}`;
}

function replacePathParams(url: string, pathParams: QueryOrPathParam[], args: Record<string, unknown>): string {
  let updatedUrl = url;
  for (const param of pathParams) {
    const value = args[param.key];
    if (value === undefined || value === null) {
      continue;
    }
    const valueAsString = String(value);
    updatedUrl = updatedUrl.replace(new RegExp(`{{\\s*${param.key}\\s*}}`, "g"), valueAsString);
    updatedUrl = updatedUrl.replace(new RegExp(`:${param.key}(?=/|$)`, "g"), valueAsString);
    updatedUrl = updatedUrl.replace(new RegExp(`{${param.key}}`, "g"), valueAsString);
  }
  return updatedUrl;
}

function buildSchema(
  queryParams: QueryOrPathParam[],
  pathParams: QueryOrPathParam[],
  bodyFields: BodyField[],
  method: string
): z.ZodObject<Record<string, z.ZodType<unknown>>> {
  const shape: Record<string, z.ZodType<unknown>> = {};

  for (const queryParam of queryParams) {
    shape[queryParam.key] = z.string().optional().describe(queryParam.description);
  }

  for (const pathParam of pathParams) {
    shape[pathParam.key] = z.string().describe(pathParam.description);
  }

  if (method !== "GET" && method !== "HEAD") {
    if (bodyFields.length > 0) {
      const bodyShape: Record<string, z.ZodType<unknown>> = {};
      for (const bodyField of bodyFields) {
        bodyShape[bodyField.key] = bodyField.schema.optional().describe(bodyField.description);
      }
      shape.body = z.object(bodyShape).optional().describe("Request body");
    } else {
      shape.body = z.record(z.string(), z.unknown()).optional().describe("Request body");
    }
  }

  // Allow runtime-injected non-LLM fields (e.g. authToken from toolNode)
  // while still keeping them out of the exposed tool schema shape.
  return z.object(shape).loose();
}

export function postmanToTools(
  collection: PostmanCollection,
  axiosInstance: AxiosInstance,
  toolsConfig: Record<string, string> = {},
  retryConfig: RetryConfig = {},
  headerResolver?: HeaderResolver,
  debug: boolean = false
): ToolDictionary {
  const requests = flattenPostmanCollection(collection);
  const tools: ToolDictionary = {};
  const usedNames = new Set<string>();
  const configuredBaseUrl = toolsConfig.BASE_URL ?? "";
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

  for (const request of requests) {
    const method = request.request.method.toUpperCase();
    const rawUrl = getRawUrl(request.request.url);
    if (!rawUrl) {
      continue;
    }

    const originalName = generateToolName(request, method, rawUrl);
    let name = originalName;
    let suffix = 1;
    while (usedNames.has(name)) {
      name = `${name}_${suffix}`;
      suffix += 1;
    }
    if (name !== originalName) {
      console.warn(
        `[postmanToTools] Tool name collision detected: '${originalName}' renamed to '${name}'. Fix duplicate names in your Postman collection.`
      );
    }
    usedNames.add(name);

    const queryParams = extractQueryParams(request);
    const pathParams = extractPathParams(request);
    const bodyFields = extractBodyFields(request);
    const schema = buildSchema(queryParams, pathParams, bodyFields, method);
    const description = generateDescription(request);

    tools[name] = new DynamicStructuredTool({
      name,
      description,
      schema,
      func: async (toolArgs: Record<string, unknown>) => {
        try {
          const args = toolArgs ?? {};
          const params: Record<string, string> = {};

          for (const param of queryParams) {
            const value = args[param.key];
            if (value !== undefined && value !== null) {
              params[param.key] = String(value);
            }
          }

          const baseUrlFromArgs =
            typeof args.BASE_URL === "string" ? args.BASE_URL : configuredBaseUrl;
          let finalUrl = normalizeUrl(rawUrl.split("?")[0], baseUrlFromArgs);
          finalUrl = replacePathParams(finalUrl, pathParams, args);

          const authToken = typeof args.authToken === "string" ? args.authToken : undefined;
          const headers = resolvedHeaderResolver(name, authToken);

          const bodyPayload: Record<string, unknown> = {};
          if (args.body && typeof args.body === "object" && !Array.isArray(args.body)) {
            Object.assign(bodyPayload, args.body as Record<string, unknown>);
          }

          if (debug) {
            // Keep debug output serializable and deterministic.
            const redactedBody = Object.keys(bodyPayload).length
              ? Object.fromEntries(Object.keys(bodyPayload).map((key) => [key, "[REDACTED]"]))
              : undefined;
            console.log(
              "[postmanToTools] Request",
              JSON.stringify(
                { method, url: finalUrl, params: Object.keys(params), body: redactedBody },
                null,
                2
              )
            );
          }

          let responseData: unknown;
          const requestConfig = {
            method,
            url: finalUrl,
            params,
            data: method === "GET" || method === "HEAD" ? undefined : bodyPayload,
            headers,
            timeout,
          };

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const response = await axiosInstance.request(requestConfig);
              responseData = response.data;
              break;
            } catch (error: unknown) {
              if (!isAxiosError(error)) {
                throw error;
              }

              const status = error.response?.status;
              const isRetryableStatus = typeof status === "number" && retryOnStatusCodes.has(status);
              const isRetryableNetworkError =
                !error.response && (error.code === "ECONNABORTED" || error.code === "ECONNRESET");
              const shouldRetry = (isRetryableStatus || isRetryableNetworkError) && attempt < maxRetries;

              if (!shouldRetry) {
                throw error;
              }

              const delay = retryDelayMs * (2 ** attempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }

          if (debug) {
            console.log(
              "[postmanToTools] Response",
              JSON.stringify(responseData, null, 2)
            );
          }

          return truncateToolResponse(JSON.stringify(responseData, null, 2), maxToolResponseBytes);
        } catch (error: unknown) {
          if (isAxiosError(error) && (error.code === "ECONNABORTED" || error.message.toLowerCase().includes("timeout"))) {
            return `Error: Request timed out after ${timeout}ms`;
          }
          if (isAxiosError(error) && error.response) {
            const status = error.response.status;
            if (debug) {
              console.error("[postmanToTools] Tool request failed", {
                toolName: name,
                status,
                responseBody: "[REDACTED]",
                message: error.message,
              });
            }
            return `Error calling ${name}: HTTP ${status}`;
          }
          if (error instanceof Error) {
            return `Error: ${error.message}`;
          }
          return "Error: Unknown error";
        }
      },
    });
  }

  return tools;
}
