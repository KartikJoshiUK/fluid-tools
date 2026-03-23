import { beforeEach, describe, expect, it, vi } from "vitest";
import { postmanToTools } from "../converters/postman-to-tools";
import type { PostmanCollection } from "../converters/types";

const axiosMock = {
  request: vi.fn(),
} as any;

describe("postmanToTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Single GET endpoint creates one tool with correct name/description", () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Get Users",
          request: {
            method: "GET",
            url: "https://api.example.com/users",
            description: "Fetch users from API",
          },
        },
      ],
    };

    const tools = postmanToTools(collection, axiosMock);
    expect(Object.keys(tools)).toEqual(["get_get_users"]);
    expect(tools.get_get_users.description).toContain("Fetch users from API");
    expect(tools.get_get_users.metadata?.method).toBe("GET");
  });

  it("Folder names are prepended to tool names for uniqueness", () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Users",
          item: [
            {
              name: "List",
              request: {
                method: "GET",
                url: "https://api.example.com/users",
              },
            },
          ],
        },
      ],
    };

    const tools = postmanToTools(collection, axiosMock);
    expect(Object.keys(tools)).toEqual(["get_users_list"]);
  });

  it("Path params (:id, {{id}}, {id}) all extracted correctly", () => {
    const collection: PostmanCollection = {
      item: [
        { name: "Colon", request: { method: "GET", url: "https://api.example.com/users/:id" } },
        { name: "Braces", request: { method: "GET", url: "https://api.example.com/users/{{id}}" } },
        { name: "OpenAPI", request: { method: "GET", url: "https://api.example.com/users/{id}" } },
      ],
    };

    const tools: any = postmanToTools(collection, axiosMock);
    expect(tools.get_colon.schema.safeParse({ id: 123 }).success).toBe(false);
    expect(tools.get_braces.schema.safeParse({ id: 123 }).success).toBe(false);
    expect(tools.get_openapi.schema.safeParse({ id: 123 }).success).toBe(false);
  });

  it("Query params extracted correctly", () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Search Users",
          request: {
            method: "GET",
            url: "https://api.example.com/users?limit=10&offset=0",
          },
        },
      ],
    };

    const tools: any = postmanToTools(collection, axiosMock);
    expect(tools.get_search_users.schema.safeParse({ limit: 10 }).success).toBe(false);
    expect(tools.get_search_users.schema.safeParse({ offset: 10 }).success).toBe(false);
  });

  it("Body fields inferred from raw JSON sample", () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Create User",
          request: {
            method: "POST",
            url: "https://api.example.com/users",
            body: {
              mode: "raw",
              raw: JSON.stringify({ name: "Alice", age: 20, active: true }),
            },
          },
        },
      ],
    };

    const tools: any = postmanToTools(collection, axiosMock);
    const ok = tools.post_create_user.schema.safeParse({
      body: { name: "Bob", age: 21, active: false },
    });
    const bad = tools.post_create_user.schema.safeParse({
      body: { name: 123, age: "21", active: "false" },
    });

    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it("Collision: two tools with same name -> second gets _1 suffix + console.warn logged", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const collection: PostmanCollection = {
      item: [
        { name: "Users", request: { method: "GET", url: "https://api.example.com/users" } },
        { name: "Users", request: { method: "GET", url: "https://api.example.com/users/all" } },
      ],
    };

    const tools = postmanToTools(collection, axiosMock);
    expect(Object.keys(tools)).toEqual(["get_users", "get_users_1"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("Empty collection returns empty ToolDictionary", () => {
    const collection: PostmanCollection = { item: [] };
    const tools = postmanToTools(collection, axiosMock);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it("retries transient failures and succeeds on later attempt", async () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Get Users",
          request: {
            method: "GET",
            url: "https://api.example.com/users",
          },
        },
      ],
    };

    axiosMock.request
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500 },
        message: "Server error",
      })
      .mockRejectedValueOnce({
        isAxiosError: true,
        code: "ECONNRESET",
        message: "socket hang up",
      })
      .mockResolvedValueOnce({ data: { ok: true } });

    const tools: any = postmanToTools(
      collection,
      axiosMock,
      {},
      { maxRetries: 2, retryDelayMs: 1 }
    );
    const result = await tools.get_get_users.invoke({});

    expect(axiosMock.request).toHaveBeenCalledTimes(3);
    expect(result).toContain('"ok": true');
  });

  it("schema does not expose authToken", () => {
    const collection: PostmanCollection = {
      item: [
        {
          name: "Get Users",
          request: {
            method: "GET",
            url: "https://api.example.com/users",
          },
        },
      ],
    };
    const tools = postmanToTools(collection, axiosMock);
    const schemaKeys = Object.keys((tools.get_get_users.schema as any).shape);
    expect(schemaKeys).not.toContain("authToken");
  });
});
