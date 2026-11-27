# Remote MCP and integrations

FlareMail can share read-only mail access with ChatGPT and other MCP clients. The
service is disabled until the Owner enables it in **Settings → Integrations**.
Browser and REST access continue to use the configured FlareMail authentication
mode.

One Streamable HTTP endpoint serves the current MCP revision `2026-07-28`
through `server/discover` and also supports the `2025-11-25` handshake used
by earlier clients. Both revisions use the same tool catalog, OAuth grants
and scope checks. [Official SDK protocol compatibility](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)

## Configure the Worker

1. Pick one canonical HTTPS hostname for the mailbox, consent page, OAuth
   issuer, and MCP endpoint. Set `APP_BASE_URL` to its origin and
   `MCP_PUBLIC_URL` to the exact same origin followed by `/mcp`. Production and
   PRE require HTTPS. Local development permits exact HTTP loopback origins. Use HTTPS for local WebKit consent testing so the browser sends the Secure cookie.
2. Provision a dedicated Workers KV namespace per environment with separate
   authorization. Set the top-level `oauthKvId` in that environment's private
   Cloudflare target JSON to its namespace ID. Configuration binds it as
   `OAUTH_KV`. The same Worker uses its existing `DB` and `BUCKET`. Each PRE
   instance needs isolated D1, R2, OAuth KV and Owner credentials. No additional
   Worker Secret is needed. The OAuth Provider stores encrypted grant properties
   and hashed credentials. D1 stores SHA-256 credential digests and the policy
   state.
3. Apply migration `0043_mcp_integration.sql` in the authorized target's normal
   migration sequence. Follow the [production checklist](PRODUCTION_CHECKLIST.md#schema-43-mcp-upgrade)
   for the exact code and schema cutover.
4. Sign in as the existing Owner. Open **Settings → Integrations**, check the
   endpoint and configuration state, select permissions, and enable MCP. Each
   client needs its own Owner approval. Attachment metadata starts unchecked in
   both settings and consent.

Optional `MCP_ALLOWED_REDIRECT_URIS` is a comma-separated list of exact redirect
URIs for additional clients. The standard ChatGPT callback
`https://chatgpt.com/connector_platform_oauth_redirect` is built in. If ChatGPT
shows a callback-ID-specific URL, copy that exact URL from its plugin management
page into the allowlist. The provider advertises RFC 9207 issuer identification
and returns `iss` on success and on consent denial. Client registration uses
DCR with PKCE S256. The server advertises its actual client authentication
methods. See [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth#redirect-url).

### Cloudflare Access

With `AUTH_MODE=cloudflare-access`, keep the existing Owner application and its
validated issuer, audience, subject, and Stable Owner mapping. These precise
public machine paths need to reach the Worker without an Access login:

| Path | Method | Application check |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server` | GET, HEAD | Public discovery on the canonical host while enabled |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource` | GET, HEAD | Public resource discovery on the canonical host while enabled |
| `/mcp/register` | POST | Bounded DCR with exact allowlisted redirects and rate limits |
| `/mcp/token` | POST | OAuth client and code/refresh/token validation |
| `/mcp` | POST | OAuth bearer, exact audience, and current Owner grant/scopes |
| `/mcp/authorize` | GET, POST | Existing Browser Owner login, session-bound consent, CSRF |

Add exact `public` path overrides to the existing Access destination for
the six machine URLs above. Destination `overrides[].path_pattern` entries
match without implicitly covering subpaths. Keep `/mcp/authorize` protected
by the existing Owner application and its existing audience. Verify the Edge
policy with an anonymous client.
[Access application destination overrides](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/). The Worker recognizes machine paths
by exact pathname and checks the canonical hostname. Keep the remaining Web and
API paths covered by the existing Access application and keep alternate Worker
hostnames closed according to the normal release checklist. Local auth also
requires an existing Owner browser session for consent. It applies the same
form origin and session checks. See [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

## Tools and scope

| Scope | Read-only tools |
| --- | --- |
| `mail.read` | `search`, `fetch`, `search_messages`, `list_messages`, `get_message`, `get_thread`, `get_delivery_status` |
| `mail.metadata.read` | `list_domains`, `list_mail_addresses`, `get_mailbox_metrics`, `list_labels` |
| `mail.attachments.metadata.read` | `list_attachments` |

`search` accepts a query and returns up to 20 IDs, titles, snippets, and links.
`fetch` accepts one ID and returns plain-text content, citation URL and safe
metadata. Domain-specific results include structured JSON and a compatible JSON
text result. Full mail and metadata tools accept only their declared parameters.

`search_messages` and `list_messages` default to inbox, archive and sent,
descending by timestamp and ID. Use `folder: drafts` or
`get_message({id, includeDraft: true})` to request drafts explicitly.
Use `identity: domain:<id>` or `address:<id>`, `envelopeRecipient` for exact
inbound SMTP recipients, or `category` for inbox/archived categories. The same
FTS syntax supports keywords in English and Chinese and operators `from:`,
`to:`, `cc:`, `subject:`, `label:`, `after:`, `before:`, `is:unread`,
`is:starred`, `is:archived`, `has:attachment`, and `status:`.
Pass `nextCursor` back as `cursor` with the same filters. Tools reject invalid
and incompatible combinations. `status:` applies to Sent by default and to
explicit draft queries where applicable. Mail queries exclude trash and
quarantine, including direct ID lookups.

`get_thread` accepts a visible anchor message. It paginates the summaries with
the same verified stored RFC key and reports `coverage: same_rfc_key`. Older
replies that store a different parent key can be outside this result. An anchor
without an RFC key returns as a one-message result. Mail links use the normal
authenticated reader. A draft link resumes after Owner sign-in and opens only
while the draft remains active.
Mail queries leave read, star, archive, and deletion state unchanged.
Continue pagination when a page returns a cursor. A bounded scan can return a
short page when stored keys disagree with RFC headers.

For addresses, `sendConfigured` and `receiveConfigured` reflect saved address
flags. Use `list_domains` to inspect domain enablement. Provider delivery and
routing readiness are separate checks.

The page size defaults to 20 and tops out at 30 for mail and 40 for domain,
address and attachment metadata. Search fans out to at most five indexed source
queries, merges them under one cursor and skips full result counts. Body
responses use at most one R2 read and a 24 KiB UTF-8 text budget. When the
canonical R2 object exceeds 512 KiB, the tool uses the stored projection and sets
`textTruncated`. HTML-only mail is converted to safe text. Request bodies are
limited to 16 KiB for MCP and 8 KiB for OAuth, and serialized tool content has a
64 KiB ceiling before duplication into the compatibility text field. The Worker
uses a 10-second application deadline and stops returning mail when a cancelled
or expired operation finishes. Cloudflare D1 and R2 calls already submitted can
finish independently of the client.

No tool returns BCC, raw HTML, raw message objects, attachment bytes or content
IDs, provider responses, storage keys, or credentials. Email and attachment
fields may contain misleading instructions. FlareMail supplies them as data and
only exposes read tools. External clients may process or retain the selected
mail under their own policies. Links and responses remain private.

## Connect from ChatGPT

1. In ChatGPT on the web, open **Plugins** and choose the option to add a
   custom MCP server. Availability depends on the account and workspace policy.
2. Paste the exact endpoint from FlareMail, choose **OAuth** and select DCR
   where the client asks for a registration method. Use the callback displayed by
   ChatGPT and the redirect configuration above.
3. Install/connect the plugin. Sign in through FlareMail's normal Owner login.
   Review the client name, redirect host and scopes before approving.
4. Verify tool discovery and call `search`, `fetch`, and one domain tool using
   synthetic mail. Check citation links in an unauthenticated and Owner browser.
   Test a follow-up query. Verify refresh after the 10-minute access lifetime.
5. Revoke this authorization from FlareMail. Verify ChatGPT can no longer use
   or refresh the grant. After reconnecting, verify global disable has the
   same effect for all clients. Test new authorization after re-enabling.

Follow the current [ChatGPT custom MCP guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
for account and workspace controls.

Other MCP clients can use the same Streamable HTTP URL with OAuth discovery.
Use the exact HTTPS callback they provide, or an exact HTTP loopback callback
in the local test target. For clients that can run the authorization code flow
outside their UI, direct the official MCP SDK's
`StreamableHTTPClientTransport` at that endpoint with its OAuth provider adapter.

## Local and PRE verification

Build and migrate the local Worker with the normal development commands. To
exercise full OAuth and tools against isolated demo mail, run the repository
Playwright test with the opt-in local MCP target. The runner generates an isolated loopback HTTPS certificate using OpenSSL:

```sh
FLAREMAIL_E2E_MCP=true FLAREMAIL_E2E_PROJECT=desktop bunx playwright test tests/e2e/mcp-integration.spec.ts --project=desktop
```

Run each project separately for isolated rate limits. The test uses the official
SDK as a compatible Streamable HTTP client.
Alternatively, run the [official Inspector](https://github.com/modelcontextprotocol/inspector)
and choose Streamable HTTP. Configure the Inspector client's exact callback URI,
start OAuth, log in as the local Owner, and approve. Test initialization, tools
list, search, fetch, pagination, and checked scope denial. Enable the Service in
the isolated test Worker first. Use only synthetic fixtures.

For remote PRE follow [the PRE procedure](PREVIEW.md#remote-mcp-acceptance). A
local compatible-client pass is separate from a remote PRE pass and real
ChatGPT OAuth and refresh acceptance.

## Revocation and troubleshooting

- **Unavailable or incomplete**. Check the canonical URL, migration, KV binding
  and target separation. A browser status check exercises KV availability.
- **Access appears instead of OAuth**. Check the precise Edge path policy,
  canonical host, and the Owner-only exception for the consent page.
- **Invalid client, redirect or resource**. Check the actual callback URL, exact
  target resource, RFC 9207 `iss`, and S256 PKCE. Following a configuration
  change, create a fresh client connection.
- **Scope denied**. Enable the intended policy and authorize again. Scope
  expansion leaves previous grants unchanged. A narrowing takes effect on the
  next use and refresh.
- **Expired or revoked**. A grant lasts 30 days. Refresh rotates the credential.
  Reuse of a consumed code or refresh credential can revoke the authorization.
  KV replication can delay visibility of a freshly issued credential across
  Cloudflare regions. Retry a transient validation failure briefly before
  starting a new authorization. If refresh was interrupted after consumption,
  sign in and authorize again.
- **Rollback**. Disable in Settings to atomically revoke all grants and reject
  further OAuth requests. Single and all-client revocation also work while
  configuration is incomplete. Keep the migrated schema and follow the release
  checklist for any compatible Worker rollback.

KV supplies provider storage and adds read/write operations to discovery and
OAuth flows. Tool requests use existing Worker/D1 capacity and R2 only when
reading a small canonical body. DCR is limited to 10 requests per minute per IP
and 100 validated registrations per 24-hour window per deployment database.
This leaves KV write capacity for consent and token exchanges. Token operations
are limited to 30 requests per minute per IP, and MCP to 120 per IP and 60 per grant. At most 100 live or pending grants are accepted. Existing Cron prunes expired state and
tool audit rows in bounded hourly batches. The audit keeps at most 20,000 tool calls. Hourly cleanup removes entries older than 30 days. Entries contain client name, tool name, result class, timing and request ID. Review actual plan quotas
before deployment. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

The current tool catalog is read-only. Mail writes, attachment downloads,
CIMD, OAuth/OIDC account linking beyond the Owner, and Apps SDK UI are outside
this implementation.
