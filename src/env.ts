/** Cloudflare's native rate limiter binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Upstream response cache. Key = normalized API request URL. */
  WIKI_CACHE: KVNamespace;
  /** Durable Object namespace backing each McpAgent session. */
  MCP_OBJECT: DurableObjectNamespace;
  /** Per-client request limiter. Absent in local dev. */
  MCP_RATE_LIMITER?: RateLimiter;
  /**
   * Optional secret path segment. When set, the server answers only at
   * `/mcp/<secret>`; when unset it serves the plain `/mcp` path.
   * Set with `wrangler secret put MCP_SECRET_PATH` — never commit it.
   */
  MCP_SECRET_PATH?: string;
  /**
   * Optional OSRS username. When set, the player tools may be called without a
   * username and will use this account.
   */
  DEFAULT_PLAYER?: string;
}
