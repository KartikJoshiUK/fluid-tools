import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import type { RateLimitConfig } from '../types/ratelimit.types';
import {
    DEFAULT_SESSION_DURATION_MS,
    MAX_SESSION_CLEANUP_INTERVAL_MS,
    MIN_SESSION_CLEANUP_INTERVAL_MS,
} from '../constants/runtime.constants';

type SessionEntry = {
    threadId: string;
    expiry: number;
    queryTimestamps: number[];
    inFlightQueries: number;
};

class FluidSession {
    private sessionMap: Map<string, SessionEntry>;
    private threadToTokenKey: Map<string, string>;
    private sessionDuration: number;
    private cleanupTimer: ReturnType<typeof setInterval>;

    constructor(sessionDuration: number = DEFAULT_SESSION_DURATION_MS, cleanupIntervalMs?: number){
        this.sessionMap = new Map();
        this.threadToTokenKey = new Map();
        this.sessionDuration = sessionDuration;
        const resolvedCleanupIntervalMs = Math.max(
            MIN_SESSION_CLEANUP_INTERVAL_MS,
            Math.min(cleanupIntervalMs ?? this.sessionDuration, MAX_SESSION_CLEANUP_INTERVAL_MS)
        );
        this.cleanupTimer = setInterval(() => this.sweepExpiredSessions(), resolvedCleanupIntervalMs);
        this.cleanupTimer.unref?.();
    }

    private sweepExpiredSessions(): void {
        const now = Date.now();
        for (const [tokenKey, session] of this.sessionMap.entries()) {
            if (session.expiry < now) {
                this.threadToTokenKey.delete(session.threadId);
                this.sessionMap.delete(tokenKey);
            }
        }
    }

    private validateAccessToken(accessToken: string | undefined): string {
        if (typeof accessToken !== "string" || accessToken.trim() === "") {
            throw new Error("accessToken is required and must be a non-empty string");
        }
        return accessToken;
    }

    private getTokenKey(accessToken: string): string {
        return createHash("sha256").update(accessToken).digest("hex");
    }

    private getExistingSession(accessToken: string){
        return this.sessionMap.get(this.getTokenKey(accessToken)) ?? null;
    }

    private setupSession(accessToken: string){
        const now = Date.now();
        const existingSession = this.getExistingSession(accessToken);
        const threadId = existingSession?.threadId ?? uuidv4();
        const tokenKey = this.getTokenKey(accessToken);
        const session: SessionEntry = {
            threadId,
            expiry: now + this.sessionDuration,
            queryTimestamps: existingSession?.queryTimestamps ?? [],
            inFlightQueries: existingSession?.inFlightQueries ?? 0,
        }
        this.sessionMap.set(tokenKey, session);
        this.threadToTokenKey.set(threadId, tokenKey);
        return session;
    }

    public deleteSession(accessToken: string | undefined){
        const validatedToken = this.validateAccessToken(accessToken);
        const tokenKey = this.getTokenKey(validatedToken);
        const existingSession = this.sessionMap.get(tokenKey);
        if(existingSession){
            this.threadToTokenKey.delete(existingSession.threadId);
            this.sessionMap.delete(tokenKey);
        }
    }

    private extendSession(accessToken: string){
        const now = Date.now();
        const existingSession = this.getExistingSession(accessToken);
        if(existingSession){
            this.sessionMap.set(this.getTokenKey(accessToken), {
                threadId: existingSession.threadId,
                expiry: now + this.sessionDuration,
                queryTimestamps: existingSession.queryTimestamps,
                inFlightQueries: existingSession.inFlightQueries,
            });
        }
    }

    public getSession(accessToken: string | undefined, onExpiry?: (threadId: string) => void) {
        const validatedToken = this.validateAccessToken(accessToken);
        const now = Date.now();
        const existingSession = this.getExistingSession(validatedToken);
        if (existingSession) {
            if (existingSession.expiry < now) {
                onExpiry?.(existingSession.threadId);
                this.deleteSession(validatedToken);
            } else {
                this.extendSession(validatedToken)
            }
        }

        const session = this.setupSession(validatedToken);

        return {
          threadId: session.threadId,
          expiry: session.expiry,
        };
    }

    public checkRateLimit(
      accessToken: string | undefined,
      config?: RateLimitConfig
    ): { allowed: boolean; retryAfterMs?: number } {
      const validatedToken = this.validateAccessToken(accessToken);
      const now = Date.now();
      const session = this.getExistingSession(validatedToken) ?? this.setupSession(validatedToken);
      const windowMs = config?.windowMs ?? 60000;
      const maxQueriesPerWindow = config?.maxQueriesPerWindow;

      session.queryTimestamps = session.queryTimestamps.filter((timestamp) => now - timestamp < windowMs);
      if (
        typeof maxQueriesPerWindow === "number" &&
        maxQueriesPerWindow >= 0 &&
        session.queryTimestamps.length >= maxQueriesPerWindow
      ) {
        const oldestTimestamp = session.queryTimestamps[0] ?? now;
        const retryAfterMs = Math.max(0, windowMs - (now - oldestTimestamp));
        this.sessionMap.set(this.getTokenKey(validatedToken), session);
        return { allowed: false, retryAfterMs };
      }

      session.queryTimestamps.push(now);
      this.sessionMap.set(this.getTokenKey(validatedToken), session);
      return { allowed: true };
    }

    public acquireConcurrencySlot(
      accessToken: string | undefined,
      config?: RateLimitConfig
    ): { allowed: boolean; retryAfterMs?: number } {
      const validatedToken = this.validateAccessToken(accessToken);
      const session = this.getExistingSession(validatedToken) ?? this.setupSession(validatedToken);
      const maxConcurrentQueries = config?.maxConcurrentQueries;

      if (
        typeof maxConcurrentQueries === "number" &&
        maxConcurrentQueries >= 0 &&
        session.inFlightQueries >= maxConcurrentQueries
      ) {
        return { allowed: false, retryAfterMs: config?.windowMs ?? 60000 };
      }

      session.inFlightQueries += 1;
      this.sessionMap.set(this.getTokenKey(validatedToken), session);
      return { allowed: true };
    }

    public releaseConcurrencySlot(accessToken: string | undefined): void {
      if (typeof accessToken !== "string" || accessToken.trim() === "") {
        return;
      }
      const session = this.getExistingSession(accessToken);
      if (!session) {
        return;
      }
      session.inFlightQueries = Math.max(0, session.inFlightQueries - 1);
      this.sessionMap.set(this.getTokenKey(accessToken), session);
    }
}

export default FluidSession;