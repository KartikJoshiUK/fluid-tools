import { describe, expect, it, vi } from "vitest";
import FluidSession from "../langgraph/session";

describe("FluidSession", () => {
  it("getSession with valid token returns stable threadId on repeat calls", () => {
    const session = new FluidSession(60_000);
    const token = "token-1";

    const first = session.getSession(token);
    const second = session.getSession(token);

    expect(first.threadId).toBe(second.threadId);
  });

  it("getSession with undefined throws error", () => {
    const session = new FluidSession();
    expect(() => session.getSession(undefined)).toThrow(
      "accessToken is required and must be a non-empty string"
    );
  });

  it("getSession with expired TTL fires onExpiry and creates new session", async () => {
    const session = new FluidSession(5);
    const onExpiry = vi.fn();
    const token = "token-expiry";

    const first = session.getSession(token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = session.getSession(token, onExpiry);

    expect(onExpiry).toHaveBeenCalledOnce();
    expect(onExpiry).toHaveBeenCalledWith(first.threadId);
    expect(second.threadId).not.toBe(first.threadId);
  });

  it("deleteSession removes the session", () => {
    const session = new FluidSession();
    const token = "token-delete";
    const created = session.getSession(token);

    session.deleteSession(token);
    const recreated = session.getSession(token);
    expect(recreated.threadId).not.toBe(created.threadId);
  });

  it("enforces query rate limits within configured window", () => {
    const session = new FluidSession();
    const token = "token-ratelimit";

    const first = session.checkRateLimit(token, { maxQueriesPerWindow: 1, windowMs: 60_000 });
    const second = session.checkRateLimit(token, { maxQueriesPerWindow: 1, windowMs: 60_000 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(typeof second.retryAfterMs).toBe("number");
  });
});
