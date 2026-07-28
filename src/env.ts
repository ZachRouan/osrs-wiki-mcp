export interface Env {
  /** Upstream response cache. Key = normalized API request URL. */
  WIKI_CACHE: KVNamespace;
  /** Durable Object namespace backing each McpAgent session. */
  MCP_OBJECT: DurableObjectNamespace;
}
