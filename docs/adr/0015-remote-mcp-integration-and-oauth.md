# ADR 0015: Remote MCP integration and OAuth

Use the existing Worker with the official MCP TypeScript server SDK
`@modelcontextprotocol/server` `2.4.0`. The Fetch handler serves
`2026-07-28` requests through `server/discover` and the per-request envelope.
The SDK's legacy Web Standard transport retains `initialize`, version
negotiation and JSON responses for `2025-11-25` clients. Both transports use
one tool registration and the same OAuth checks. Sessions, batch calls and
subscriptions fall outside the bounded read-only tool interface.

The Web Standard handler runs directly in the existing Worker. It needs no
Agent runtime or Durable Objects. Legacy v1 and current v2 SDK clients verify
both protocol paths in the browser acceptance suite.
[Current MCP spec](https://modelcontextprotocol.io/specification/2026-07-28).
[SDK protocol compatibility](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

Use `@cloudflare/workers-oauth-provider` `1.4.0` for authorization server
metadata, DCR, RFC 9207, PKCE, redirect verification, encrypted opaque tokens and
the consent transaction. Code redemption and refresh wait for the KV per-key write interval before claiming a credential in D1. The token audience derives from the sole permitted
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
