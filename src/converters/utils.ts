import { PostmanCollection, PostmanRequest, PostmanUrlObject } from './types';

/**
 * Flatten Postman collection recursively
 */
export function flattenPostmanCollection(collection: PostmanCollection): PostmanRequest[] {
  const result: PostmanRequest[] = [];

  function recurse(items: PostmanCollection["item"]) {
    for (const item of items) {
      if (item.item && Array.isArray(item.item)) {
        recurse(item.item);
      } else if (item.request) {
        result.push({
          name: item.name,
          request: item.request,
        });
      }
    }
  }

  recurse(collection.item || []);
  return result;
}

/**
 * Helper to get raw URL string from request
 */
function getRawUrl(request: PostmanRequest): string {
  if (typeof request.request.url === "string") {
    return request.request.url;
  }
  return request.request.url?.raw || "";
}

/**
 * Extract query parameters from Postman request
 */
function extractQueryParams(
  request: PostmanRequest
): Array<{ key: string; description: string }> {
  const queryParams: Array<{ key: string; description: string }> = [];

  // Check if URL has query array
  if (request.request.url && typeof request.request.url === "object") {
    const urlObj = request.request.url as PostmanUrlObject;
    if (urlObj.query && Array.isArray(urlObj.query)) {
      for (const param of urlObj.query) {
        queryParams.push({
          key: param.key,
          description: param.description || `${param.key} parameter`,
        });
      }
    }
  } else if (typeof request.request.url === "string") {
    // parse inline query string fallback
    const raw = request.request.url as string;
    const qsIndex = raw.indexOf("?");
    if (qsIndex !== -1) {
      const params = new URLSearchParams(raw.slice(qsIndex + 1));
      for (const [key] of params) {
        queryParams.push({ key, description: `${key} parameter` });
      }
    }
  }

  return queryParams;
}

/**
 * Extract path parameters from URL string (handles :id, {{id}}, {id})
 */
function extractPathParams(
  request: PostmanRequest
): Array<{ key: string; description: string }> {
  const pathParams: Array<{ key: string; description: string }> = [];
  const raw = getRawUrl(request);

  // Remove protocol and host:port to avoid matching port numbers as params
  // e.g., "http://localhost:8000/users/:id" → "/users/:id"
  const pathOnly = raw.replace(/^[a-zA-Z]+:\/\/[^/]+/, "");

  // Match :param style (only in path, not port numbers)
  const colonMatches = Array.from(
    pathOnly.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)
  ).map((m) => m[1]);
  for (const k of colonMatches) {
    pathParams.push({ key: k, description: `${k} path parameter` });
  }

  // Match {{param}} style
  const mustacheMatches = Array.from(
    raw.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)
  ).map((m) => m[1]);
  for (const k of mustacheMatches) {
    if (!pathParams.find((p) => p.key === k))
      pathParams.push({ key: k, description: `${k} path parameter` });
  }

  // Match {param} style
  const braceMatches = Array.from(raw.matchAll(/{([A-Za-z0-9_]+)}/g)).map(
    (m) => m[1]
  );
  for (const k of braceMatches) {
    if (!pathParams.find((p) => p.key === k))
      pathParams.push({ key: k, description: `${k} path parameter` });
  }

  // Also try url.path array (Postman structured)
  if (request.request.url && typeof request.request.url === "object") {
    const urlObj = request.request.url as PostmanUrlObject;
    if (Array.isArray(urlObj.path)) {
      for (const segment of urlObj.path) {
        const m = String(segment).match(/^:([A-Za-z0-9_]+)$/);
        if (m) {
          if (!pathParams.find((p) => p.key === m[1]))
            pathParams.push({
              key: m[1],
              description: `${m[1]} path parameter`,
            });
        }
      }
    }
  }

  return pathParams;
}

/**
 * Extract body fields from Postman request body (raw JSON mode)
 * Returns an array of field definitions with inferred types
 */
function extractBodyFields(request: PostmanRequest): Array<{
  key: string;
  type: string;
  description: string;
  required: boolean;
}> {
  const bodyFields: Array<{
    key: string;
    type: string;
    description: string;
    required: boolean;
  }> = [];

  const body = request.request.body;
  if (!body) return bodyFields;

  // Handle raw JSON body
  if (body.mode === "raw" && body.raw) {
    try {
      const parsed = JSON.parse(body.raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        for (const [key, value] of Object.entries(parsed)) {
          const zodType = inferZodType(value);
          bodyFields.push({
            key,
            type: zodType,
            description: `${key} field`,
            required: false, // Make all optional for flexibility
          });
        }
      }
    } catch {
      // JSON parse failed, skip body field extraction
    }
  }

  // Handle urlencoded body
  if (body.mode === "urlencoded" && Array.isArray(body.urlencoded)) {
    for (const field of body.urlencoded) {
      bodyFields.push({
        key: field.key,
        type: "z.string()",
        description: field.description || `${field.key} field`,
        required: false,
      });
    }
  }

  // Handle formdata body
  if (body.mode === "formdata" && Array.isArray(body.formdata)) {
    for (const field of body.formdata) {
      const isFile = field.type === "file";
      bodyFields.push({
        key: field.key,
        type: isFile ? "z.unknown()" : "z.string()",
        description:
          field.description || `${field.key} ${isFile ? "(file)" : "field"}`,
        required: false,
      });
    }
  }

  return bodyFields;
}

/**
 * Infer Zod type from a JavaScript value
 */
function inferZodType(value: unknown): string {
  if (value === null) return "z.unknown().nullable()";
  if (typeof value === "string") return "z.string()";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "z.number().int()" : "z.number()";
  }
  if (typeof value === "boolean") return "z.boolean()";
  if (Array.isArray(value)) {
    if (value.length > 0) {
      const itemType = inferZodType(value[0]);
      return `z.array(${itemType})`;
    }
    return "z.array(z.unknown())";
  }
  if (typeof value === "object") {
    // For nested objects, just use z.object with z.unknown() for simplicity
    // Could be made recursive for deeper typing
    return "z.record(z.unknown())";
  }
  return "z.unknown()";
}

/**
 * Generate a semantic tool name from the request
 */
function generateToolName(
  request: PostmanRequest,
  url: string,
  method: string
): string {
  // If the request name is meaningful (not just "New Request"), use it
  if (request.name && !request.name.toLowerCase().includes("new request")) {
    return request.name
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[0-9]/, "_$&")
      .toLowerCase();
  }

  // Otherwise, generate from URL path
  const pathMatch = url.match(/\/([^/?]+)(?:\/[^/?]*)?$/);
  const resource = pathMatch ? pathMatch[1] : "api";

  const methodPrefix = method.toLowerCase();
  return `${methodPrefix}_${resource}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Generate a semantic description based on the endpoint
 * Prioritizes user-provided descriptions from Postman
 */
function generateSmartDescription(request: PostmanRequest): string {
  const method = request.request.method || "GET";
  const url = getRawUrl(request);
  const name = request.name;
  const givenDescription = request.request.description ?? "";

  // Check if user provided a description in Postman
  const userDescription = request.request.description;
  if (userDescription) {
    // User provided description - use it!
    if (typeof userDescription === "string") {
      return userDescription;
    }
    return userDescription.content ?? "";
  }

  // Fallback: Generate description automatically
  const pathMatch = url.match(/\/([^/?]+)(?:\?|$)/);
  const resource = pathMatch ? pathMatch[1] : "resource";

  let action = "";
  switch (method.toUpperCase()) {
    case "GET":
      action = name?.toLowerCase().includes("list")
        ? "Retrieves a list of"
        : "Retrieves information about";
      break;
    case "POST":
      action = "Creates a new";
      break;
    case "PUT":
    case "PATCH":
      action = "Updates an existing";
      break;
    case "DELETE":
      action = "Deletes a";
      break;
    default:
      action = "Performs an operation on";
  }

  return `${action} ${resource.replace(
    /-/g,
    " "
  )}. ${givenDescription}. Endpoint: ${method} ${url}`;
}

/**
 * Generate LangChain-compatible Zod schema code as a string
 * This returns TypeScript code that can be used with LangChain's tool() function
 */
export function postmanToLangChainCode(collection: PostmanCollection): string {
  const requests = flattenPostmanCollection(collection);

  let code = `// Generated LangChain tools from Postman collection\n`;
  code += `// Collection: ${collection.info?.name || "Unknown"}\n\n`;
  code += `export function generateTools(tool: unknown, z: unknown, axios: unknown, debug?: boolean) {\n`;
  code += `  const tools: Record<string, unknown> = {};\n\n`;

  const usedNames = new Set<string>();

  for (const request of requests) {
    const method = (request.request.method || "GET").toUpperCase();
    const url = getRawUrl(request).split("?")[0]; // strip query for base URL

    // Skip requests with empty URLs
    if (!url || url.trim() === "") {
      console.warn(`[FluidTools: Postman Parsing] Skipping request "${request.name}" - no URL provided.`);
      continue;
    }

    // Generate a valid and semantic JavaScript variable name
    let name = generateToolName(request, url, method);

    // Ensure unique names by appending index if duplicate
    let uniqueName = name;
    let counter = 1;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${name}_${counter}`;
      counter++;
    }
    name = uniqueName;
    usedNames.add(name);

    const description = generateSmartDescription(request)
      .replace(/\n/g, " ") // Remove all newlines (use regex with g flag)
      .replace(/\r/g, " ") // Remove carriage returns
      .replace(/'/g, "\\'") // Escape single quotes
      .replace(/`/g, "\\`") // Escape backticks
      .trim();

    const queryParams = extractQueryParams(request);
    const pathParams = extractPathParams(request);
    const bodyFields = extractBodyFields(request);

    code += `  // ${request.name}\n`;
    code += `  const ${name} = tool(\n`;
    code += `    async (args: Record<string, unknown>) => {\n`;
    code += `      try {\n`;
    // Build runtime URL and params handling
    code += `        let url = \`${url}\`;\n`;
    // Build params object
    code += `        const params: Record<string, unknown> = {};\n`;
    for (const param of queryParams) {
      code += `        if (args['${param.key}'] !== undefined) params['${param.key}'] = args['${param.key}'];\n`;
    }
    // Replace path placeholders
    for (const p of pathParams) {
      // handle {{param}}, :param and {param}
      code += `        if (args['${p.key}'] !== undefined) {\n`;
      code += `          url = url.replace(new RegExp('{{\\\\s*${p.key}\\\\s*}}','g'), String(args['${p.key}']));\n`;
      code += `          url = url.replace(new RegExp(':' + ${JSON.stringify(
        p.key
      )} + '(?=/|$)','g'), String(args['${p.key}']));\n`;
      code += `          url = url.replace(new RegExp('{' + ${JSON.stringify(
        p.key
      )} + '}','g'), String(args['${p.key}']));\n`;
      code += `        }\n`;
    }

    // Log the exact request that will be sent
    code += `        if(debug) console.info('[FluidTools: Execution] Dispatched request:', JSON.stringify({ method: '${method}', url, params, body: args.body ?? null }, null, 2));\n\n`;

    // Axios call per method
    const lower = method.toLowerCase();
    if (method === "GET" || method === "HEAD") {
      code += `        const res = await axios.${lower}(url, {\n`;
      code += `          params,\n`;
      code += `          headers: args.authToken ? { Authorization: \`Bearer \${args.authToken}\` } : {},\n`;
      code += `        });\n`;
    } else if (method === "DELETE") {
      // axios.delete(url, { params, data, headers })
      code += `        const res = await axios.delete(url, {\n`;
      code += `          params,\n`;
      code += `          data: args.body ?? {},\n`;
      code += `          headers: args.authToken ? { Authorization: \`Bearer \${args.authToken}\` } : {},\n`;
      code += `        });\n`;
    } else {
      // POST, PUT, PATCH, etc. axios.post(url, data, { params, headers })
      code += `        const res = await axios.${lower}(url, args.body ?? {}, {\n`;
      code += `          params,\n`;
      code += `          headers: args.authToken ? { Authorization: \`Bearer \${args.authToken}\` } : {},\n`;
      code += `        });\n`;
    }

    // Log response
    code += `        if(debug) console.info('[FluidTools: Response] Received response:', JSON.stringify(res.data, null, 2));\n`;
    code += `        return JSON.stringify(res.data, null, 2);\n`;
    code += `      } catch (err: unknown) {\n`;
    code += `        // More detailed error logging including response body if available\n`;
    code += `        if (err.response) {\n`;
    code += `          if(debug) console.error('[FluidTools: API Error] Status Code:', err.response.status);\n`;
    code += `          if(debug) console.error('[FluidTools: API Error] Response Body:', JSON.stringify(err.response.data, null, 2));\n`;
    code += `          return \`Error: \${err.message} - Status: \${err.response.status}\\n\${JSON.stringify(err.response.data, null, 2)}\`;\n`;
    code += `        }\n`;
    code += `        if(debug) console.error('[FluidTools: API Error] Message:', err.message || err);\n`;
    code += `        return \`Error: \${err.message || err}\`;\n`;
    code += `      }\n`;
    code += `    },\n`;
    code += `    {\n`;
    code += `      name: '${name}',\n`;
    code += `      description: '${description}',\n`;
    code += `      schema: z.object({\n`;
    code += `        authToken: z.string().optional().describe('Authorization token'),\n`;

    // Add query parameters as individual fields
    if (queryParams.length > 0) {
      for (const param of queryParams) {
        code += `        '${param.key}': z.string().optional().describe('${param.description}'),\n`;
      }
    }

    // Add path params
    if (pathParams.length > 0) {
      for (const param of pathParams) {
        code += `        '${param.key}': z.string().optional().describe('${param.description}'),\n`;
      }
    }

    // Add body fields for methods that use request bodies
    if (method !== "GET" && method !== "HEAD") {
      if (bodyFields.length > 0) {
        // Generate typed body schema from Postman sample
        code += `        body: z.object({\n`;
        for (const field of bodyFields) {
          const escapedDesc = field.description.replace(/'/g, "\\'");
          code += `          '${field.key}': ${field.type}.optional().describe('${escapedDesc}'),\n`;
        }
        code += `        }).optional().describe('Request body'),\n`;
      } else {
        // Fallback to z.unknown() if no body sample found
        code += `        body: z.unknown().optional().describe('Request body'),\n`;
      }
    }

    code += `      }),\n`;
    code += `    }\n`;
    code += `  );\n`;
    code += `  tools["${name}"] = (${name});\n\n`;
  }

  code += `  return tools;\n`;
  code += `}\n`;

  return code;
}
