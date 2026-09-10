# FlareMail Telegram notifications

Telegram notifications are an additive, one-Bot-per-Worker channel for
inbound mail. Each workspace user can bind one Telegram private chat. A
binding is a candidate until the user confirms it in FlareMail, and it remains
disabled until the user explicitly enables notifications.

This feature does not replace Resend, Cloudflare Email Routing, the legacy
`INBOUND_NOTIFICATION_ENABLED` / `NOTIFICATION_EMAIL` path, or the profile
`forwardingEnabled` compatibility field. The legacy field still controls the
existing email summary behavior; it does not enable Telegram and it does not
forward the original message.

## Data and delivery boundary

The inbound Worker first stores the accepted message in D1/R2. When Telegram
is enabled, configured, and schema 22 is present, the same D1 batch inserts a
small Telegram outbox row only when all of these checks pass:

- the recipient matches `workspace_users.login_email` case-insensitively;
- the user has an active, enabled binding with the current authorization
  version;
- the message is not deleted; and
- the Telegram tables are available.

The editable profile email is intentionally not trusted for this decision.
The outbox stores ownership, message ID, binding ID, and authorization
version, not raw MIME, body, attachment bytes, or a copied notification
payload. The dispatcher reloads the message and binding before every send.

The Telegram message contains either a privacy-mode line or the sender,
recipient, subject, server-persisted receive time rendered in the user's
stored timezone, attachment count, and an optional bounded plain-text summary.
The receive time is `email_messages.created_at`; an untrusted RFC 5322
`Date` header is not used as the delivery clock. Invalid user timezone values
fall back to UTC. The message never includes the full body or attachments. A
single inline button points to the existing FlareMail mailbox URL state:
`?folder=inbox&message=email:<storage-id>`. Web page previews and Telegram
markup parsing are disabled.

Delivery is at-least-once around the external API boundary. A Worker timeout,
connection failure, or database finalization failure becomes
`unknown_delivery` and is never retried automatically. A manual retry warns
that Telegram may already have displayed the message. A `sent` row is never
an automatic retry target.

## Configuration

The checked-in Wrangler files keep Telegram disabled. For a personal online
deployment, put the values below in the Cloudflare Dashboard under **Workers
& Pages → your Worker → Settings → Variables and Secrets**. The production
example also sets `keep_vars = true`, so later code deployments keep the
Dashboard-managed values instead of replacing them with the checked-in
placeholders. The private `wrangler.deploy.toml` remains available for
operators who prefer file-based deployment:

| Variable | Kind | Required when enabled | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_ENABLED` | non-secret var | yes | Global feature switch; default `false` |
| `TELEGRAM_BOT_USERNAME` | non-secret var | yes | BotFather username without `@` |
| `APP_BASE_URL` | non-secret var | yes | Credential-free HTTPS origin used by the detail button |
| `TELEGRAM_TIMEOUT_MS` | non-secret var | no | Telegram request timeout, bounded to 1–15 seconds, default 5 seconds |
| `TELEGRAM_BOT_TOKEN` | secret | yes | Bot API credential |
| `TELEGRAM_WEBHOOK_SECRET` | secret | no | Optional independent override; otherwise derived from the Bot Token |

`APP_BASE_URL` must be an origin with no path, credentials, query, or
fragment. Production and preview require HTTPS. Development/test may use
`http://127.0.0.1`, `http://localhost`, or `http://[::1]`. The Bot Token and
any explicit webhook-secret override must never enter Git, a client response,
a user-visible or persisted application URL, or application logs. Telegram
does not provide a webhook secret: FlareMail derives a stable HMAC-based value
from the Bot Token when no override is set.

The Bot API requires the bot token in the provider endpoint URL, for example
`https://api.telegram.org/bot<token>/sendMessage`. The Worker does not log
that URL, but this repository cannot prove that every Cloudflare
Observability trace, subrequest view, or account export redacts URL path
segments. The current Workers documentation describes sampling and optional
trace/log persistence, not a guaranteed Bot-token URL redaction control. Before
enabling Telegram in production, either verify an account-level redaction
policy with a safe canary or keep Worker traces disabled and do not export or
persist request URLs; never share trace artifacts. If that boundary cannot be
verified, rotate the Bot token after any suspected exposure.

When `TELEGRAM_ENABLED=false`, inbound receive processing performs no Telegram
table scan and makes no Telegram network request. Enabling the switch with
incomplete credentials fails closed at runtime/preflight and leaves accepted
mail independent of the optional channel. Migration 0020 also installs a D1
delete trigger: deleting a workspace user revokes its retained Telegram
binding, replaces pending bind challenges, clears user/chat rate-limit state,
and cancels outbox work that has not started an external request. An already
started external request is preserved for delivery reconciliation. Migration
0021 records the consuming webhook update on each challenge so invalid,
conflicting, and successful update states are finalized atomically. Migration
0022 snapshots the least-privileged privacy and summary settings on each
outbox row; current stricter settings still apply before send, but an old row
cannot gain a summary merely because the user enabled it while the row waited.

## Recommended online setup

The normal setup no longer requires a local `.env`, `curl`, or a separate
administrator role. It still requires one initial database migration and one
Bot token entry in Cloudflare, because the token must never be sent through or
stored in the browser.

1. Create a Bot with BotFather and copy its username without `@`.
2. In **Variables and Secrets**, add these non-secret variables: `TELEGRAM_ENABLED=true`,
   `TELEGRAM_BOT_USERNAME`, the exact public `APP_BASE_URL`, and optionally
   `TELEGRAM_TIMEOUT_MS=5000`.
3. Add `TELEGRAM_BOT_TOKEN` as a **Secret** value. You may optionally add
   `TELEGRAM_WEBHOOK_SECRET` as an independent override, but it is not needed.
   Do not put either value in Git, D1, browser storage, or a URL.
4. Apply migrations 0019 through 0022 once and verify
   `workspace_schema_metadata.schema_version = 22`. Then deploy the Worker and
   click **Deploy** after saving the Dashboard variables/secrets.
5. Log in to FlareMail. In the Telegram panel, click **连接 / 更新 Webhook**.
   The Worker calls `getMe`, checks that the Bot username matches, and calls
   `setWebhook` for `/api/webhooks/telegram` automatically.
6. Click **生成 Telegram 绑定链接**, open it in your private Telegram chat,
   send `/start`, click **确认绑定**, and enable notifications when ready.

Any authenticated workspace session can perform these actions. This project is
intended for personal use, so it deliberately does not distinguish an
administrator from an ordinary user. Cloudflare Dashboard access remains the
boundary for the deployment-level Bot secret and global switch.

## Production setup order (advanced/operator reference)

Every remote operation below is an operator action requiring its own approval.
This repository change does not run migrations, deploy a Worker, register a
webhook, or send a real Telegram message.

1. Review the release commit, create/verify the intended D1 Time Travel
   bookmark, and apply migrations 0019 through 0022 to the intended D1 database.
   Confirm `workspace_schema_metadata.schema_version = 22` before enabling the
   feature.
2. Create a Bot with BotFather. Record the username without `@`. Keep the
   returned token in the secret manager only.
3. Deploy with `TELEGRAM_ENABLED=false` first, upload the Telegram Bot Token
   through the approved secret path, and optionally upload an independent
   webhook-secret override. Verify `/api/health` and the public HTTPS origin.
   Do not place secret values in `wrangler.deploy.toml`.
4. Set `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_USERNAME`, and the exact
   `APP_BASE_URL` in the reviewed private deployment config. Deploy the same
   code/config/schema combination and verify the health/config gate again.
5. The authenticated settings page can verify the bot identity and register
   exactly one webhook at:
   `https://<PUBLIC_HOST>/api/webhooks/telegram`, with the derived or explicitly
   configured secret header and `allowed_updates=["message"]`. An operator may use the manual
   Bot API checks below instead. The endpoint must not be redirected by
   Cloudflare Access, an origin proxy, or a trailing-slash rule.
6. Verify `getWebhookInfo` reports the intended URL, no pending-error backlog,
   and a recent successful delivery. Only then log in to FlareMail, generate a
   binding link, open it in the intended Telegram private chat, send `/start`,
   click **确认绑定**, and separately enable notifications.

Useful Bot API methods are `getMe`, `setWebhook`, `getWebhookInfo`, and
`deleteWebhook`. A webhook Bot must not also be polled with `getUpdates`; the
two modes conflict. Local and production deployments using the same Bot also
conflict, so use a separate development Bot or explicitly delete/re-register
the webhook during an approved local test.

### Executing Bot API checks safely

The following commands are concrete examples, but the referenced files must be
rendered by the approved secret manager outside this repository with mode
`0600`. The Bot token appears in the Bot API URL and an explicit webhook secret
appears in the `setWebhook` JSON; keeping both in a temporary `curl` config
file avoids shell history and ordinary process-argument exposure. Remove the
files after the approved check.

```bash
curl --fail-with-body --silent --show-error --config /secure/telegram-getme.curl
curl --fail-with-body --silent --show-error --config /secure/telegram-set-webhook.curl
curl --fail-with-body --silent --show-error --config /secure/telegram-get-webhook-info.curl
curl --fail-with-body --silent --show-error --config /secure/telegram-delete-webhook.curl
```

The rendered config files should POST to the corresponding endpoints:
`.../getMe`, `.../setWebhook`, `.../getWebhookInfo`, and
`.../deleteWebhook`. The `setWebhook` request body must contain the exact
`https://<PUBLIC_HOST>/api/webhooks/telegram` URL, the derived or configured
`secret_token`, `allowed_updates:["message"]`, and
`drop_pending_updates:false`. Inspect only the returned `ok`, bot username,
webhook URL, pending-update count, and last error metadata; never paste the
token, secret, chat ID, or full response into a ticket or log.

To disable the channel additively, set `TELEGRAM_ENABLED=false` and deploy.
Existing mail, D1 outbox rows, Resend behavior, and Email Routing remain
intact; the dispatcher stops scanning and sending. To rotate a token, create
the replacement secret, verify `getMe`, deploy the reviewed config, and
register the webhook again. To replace a Bot, users must bind the new Bot and
the old Bot's webhook should be deleted only after the cutover review.

## Webhook and binding behavior

The exact route `/api/webhooks/telegram` checks the secret header before
reading the body or querying D1. Only a private chat whose `from.id` equals
`chat.id` is accepted. Bot messages, groups, channels, ordinary messages, and
malformed updates are ignored and deduplicated by Telegram `update_id`; the
implementation does not use a maximum-update-ID shortcut.

- `/start <one-time-token>` consumes a pending 10-minute challenge and creates
  a disabled candidate binding.
- `/start` or `/help` returns best-effort setup guidance.
- `/stop` revokes the binding, clears the stored chat target, increments the
  authorization version, and cancels pending or not-yet-sent outbox rows.
- Active bindings cannot be silently replaced. The user must explicitly
  unbind before beginning a new binding.
- Expired, replaced, reused, or invalid tokens never identify a workspace
  user and never create a candidate.

The browser receives the one-time deep link only from the authenticated bind
route. It is not stored in localStorage, URL state, D1, or logs. The API
returns no Telegram chat ID to the browser; settings and delivery history are
always scoped to the current authenticated session.

## Dispatcher, Cron, and limits

The Worker exports `scheduled()` and both checked-in Wrangler configurations
declare `* * * * *`. Each run uses bounded sequential claims with a D1 lease
and claim token. Stale processing rows that had already started an external
request become `unknown_delivery`; stale rows that had not started can be
reclaimed. The dispatcher applies a request-level `AbortController` timeout,
reloads binding/message ownership, and limits each invocation by task count
and time budget.

Persistent D1 limits cover setup, bind, confirm, test, unbind, and manual
retry actions, plus Bot/user/chat delivery scopes. Telegram 429 responses honor
`retry_after` with jitter. Temporary failures use bounded exponential backoff
and max attempts; 401/403 and other permanent failures become terminal
`failed` rows.

The UI can verify the deployment Bot and update its Webhook, then shows
candidate/active/enabled state, the bound Telegram display-name and username
summary (never the chat ID), privacy and summary switches, test action, unbind
action, recent deliveries with localized status labels, and manual retry
warnings. API responses are the normal `{ ok, data, requestId }` no-store
envelope.

The scheduled dispatcher also expires pending challenges and candidate
bindings, cancels their not-yet-started delivery work, and removes terminal
challenge/update rows older than 30 days plus sent/failed/cancelled delivery
rows older than 180 days. Each category is capped at 500 rows per Cron run;
`unknown_delivery` rows are retained for operator review. This is a bounded
retention pass, not a destructive live-mail cleanup.

For local Worker preview, Wrangler's scheduled-test middleware can expose a
direct test endpoint for the configured Cron expression:

```bash
bun x wrangler dev --config wrangler.toml --local --test-scheduled --ip 0.0.0.0 --port 8787
curl -fsS -X POST 'http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*'
```

If the installed Wrangler instead prints that scheduled Workers are not
automatically triggered during local development, use its standard local
scheduled endpoint:

```bash
bun x wrangler dev --config wrangler.toml --local --ip 0.0.0.0 --port 8787
curl -fsS 'http://127.0.0.1:8787/cdn-cgi/local/scheduled'
```

This proves only local code, local D1, and injected/fake fetch behavior. It is
not evidence of Cloudflare Cron execution or Telegram delivery.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| `401` webhook | Secret header, exact route, no proxy rewrite, no Access challenge, and no redirect |
| `TELEGRAM_NOT_READY` | Enabled var, Bot token/username, HTTPS `APP_BASE_URL`, and schema 22 |
| Bot never sees `/start` | `getWebhookInfo`, webhook URL, pending errors, Bot blocked by the user, and production/local Bot conflict |
| Candidate expires | Generate a new link and send `/start` from the same private chat within 10 minutes |
| Confirm fails | The candidate update was not accepted, the chat is not private, or the candidate was replaced |
| No new notification | Confirmed binding, enabled switch, trusted `login_email` recipient, deleted state, D1 outbox status, and Cron backlog |
| Telegram `403` | The user blocked the Bot or the chat is no longer reachable; the row is terminal until the user rebinds |
| Telegram `429` | Inspect persistent Bot/user/chat cooldowns and wait for the stored retry time |
| `unknown_delivery` | Do not assume absence. Inspect Telegram manually, then use the UI's warned manual retry only if a duplicate is acceptable |
| Schema/readiness failure | Apply migrations in order, verify schema version 22, the Telegram tables, account-delete cleanup trigger, challenge provenance column, and privacy snapshot columns, then rerun health locally |
| `getUpdates` conflict | Delete polling or webhook mode and use only one update transport for this Bot |

Do not treat `/api/health = 200`, local unit/integration tests, a mocked
`fetch`, or a local scheduled invocation as proof of real Telegram delivery.
Real delivery evidence requires an explicitly approved production binding and
operator-observed Bot API response, and should record only safe metadata—not
tokens, message bodies, raw MIME, chat IDs, or secrets.
