# ADR 0015: Remote MCP integration and OAuth

Use the existing Worker with the official MCP TypeScript SDK `1.32.2`.
`WebStandardStreamableHTTPServerTransport` operates on Fetch APIs, with one
stateless SDK server per POST. The selected stable wire version is
`2025-11-25`, with earlier interoperable versions negotiated by the SDK.
JSON responses serve bounded read-only operations. Server-initiated SSE,
sessions and batch calls are outside the transport design.
[Stable MCP spec](https://modelcontextprotocol.io/specification/2025-11-25).
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Cloudflare's `createMcpHandler` also supports stateless deployment with no
Durable Objects. The current Cloudflare documentation uses the SDK v2 transport
and a draft protocol lane, while the pinned v1 SDK directly offers the stable
Fetch transport needed here. The existing application needs no additional Agent
runtime. [Cloudflare MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

Use `@cloudflare/workers-oauth-provider` `1.4.0` for authorization server
metadata, DCR, RFC 9207, PKCE, redirect verification, encrypted opaque tokens and
the consent transaction. The token audience derives from the sole permitted
RFC 8707 resource, the exact configured MCP URL. Deploy a dedicated
`OAUTH_KV` namespace. CIMD introduces metadata network fetch and another
trust boundary. DCR satisfies ChatGPT compatibility with a fixed redirect
allowlist and bounded registration. [Provider](https://github.com/cloudflare/workers-oauth-provider).
[ChatGPT OAuth](https://developers.openai.com/plugins/build/auth).

KV provides storage for the provider and has eventual consistency. A D1 grant
and credential ledger is authoritative after provider validation. Consent binds
the browser session and policy revision, and D1 claims a single-use consent or
exchange atomically. D1 stores only digests, scope policy, minimal approval
metadata, and activity. No separate OAuth signing secret is required for this
opaque-token design. Token responses are released only after D1 records issued
credentials, and any scope change or revoke is checked again before tool
results are returned. A failure between a claim and successful issuance can
require fresh consent. Loss of a response after refresh can also require new
consent. Prefer this failure mode over accepting a replay of a consumed refresh
credential.

The same mail Worker, canonical origin and Owner grant are sufficient. The
endpoint bypasses the application browser hook on exact machine paths only.
Owner consent continues through the normal local or Access authentication hook.
No additional Worker, Durable Objects, queue, external mail index or long-lived
process is required.
