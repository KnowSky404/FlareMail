# Remote MCP integration

Status and deployment gates are tracked separately in the [operating guide](../MCP.md).

- Phase 1 exposes stateless Streamable HTTP for read-only mail tools. Existing
  mailbox repositories provide search, filters, label membership, delivery
  state and identity boundaries. Tool responses are bounded and audited.
- Phase 2 adds OAuth 2.1 authorization code plus S256 PKCE, exact callback and
  resource checks, explicit Owner approval, token lifecycle, and settings for
  service policy, grants and activity.
- Machine paths are exact and require the configured issuer. The consent path
  stays inside the existing browser authentication boundary. All mail reads
  require a current Stable Owner grant and the declared scope.
- Tool verification uses an isolated Worker and synthetic fixtures. Follow the
  PRE guide for isolated deployment, then the ChatGPT guide for authentic client
  acceptance. Production is a separately authorized release.

See [ADR 0015](../adr/0015-remote-mcp-integration-and-oauth.md) for protocol and
storage decisions.
