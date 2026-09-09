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
is enabled, configured, and schema 19 is present, the same D1 batch inserts a
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
recipient, subject, received time, attachment count, and an optional bounded
plain-text summary. It never includes the full body or attachments. A single
inline button points to the existing FlareMail mailbox URL state:
`?folder=inbox&message=email:<storage-id>`. Web page previews and Telegram
markup parsing are disabled.

Delivery is at-least-once around the external API boundary. A Worker timeout,
connection failure, or database finalization failure becomes
`unknown_delivery` and is never retried automatically. A manual retry warns
that Telegram may already have displayed the message. A `sent` row is never
an automatic retry target.

## Configuration

The checked-in Wrangler files keep Telegram disabled. The production values
below belong in the ignored private deployment config or Wrangler secrets:

| Variable | Kind | Required when enabled | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_ENABLED` | non-secret var | yes | Global feature switch; default `false` |
| `TELEGRAM_BOT_USERNAME` | non-secret var | yes | BotFather username without `@` |
| `APP_BASE_URL` | non-secret var | yes | Credential-free HTTPS origin used by the detail button |
| `TELEGRAM_TIMEOUT_MS` | non-secret var | no | Telegram request timeout, bounded to 1–15 seconds, default 5 seconds |
| `TELEGRAM_BOT_TOKEN` | secret | yes | Bot API credential |
| `TELEGRAM_WEBHOOK_SECRET` | secret | yes | `X-Telegram-Bot-Api-Secret-Token` value |

`APP_BASE_URL` must be an origin with no path, credentials, query, or
fragment. Production and preview require HTTPS. Development/test may use
`http://127.0.0.1`, `http://localhost`, or `http://[::1]`. Tokens and webhook
secrets must never enter Git, a client response, a URL, or application logs.

When `TELEGRAM_ENABLED=false`, inbound receive processing performs no Telegram
table scan and makes no Telegram network request. Enabling the switch with
incomplete credentials fails closed at runtime/preflight and leaves accepted
mail independent of the optional channel.

## Production setup order

Every remote operation below is an operator action requiring its own approval.
This repository change does not run migrations, deploy a Worker, register a
webhook, or send a real Telegram message.

1. Review the release commit, create/verify the intended D1 Time Travel
   bookmark, and apply migration 0019 to the intended D1 database. Confirm
   `workspace_schema_metadata.schema_version = 19` before enabling the
   feature.
2. Create a Bot with BotFather. Record the username without `@`. Keep the
   returned token in the secret manager only.
3. Deploy with `TELEGRAM_ENABLED=false` first, upload the two Telegram secrets
   through the approved secret path, and verify `/api/health` and the public
   HTTPS origin. Do not place secret values in `wrangler.deploy.toml`.
4. Set `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_USERNAME`, and the exact
   `APP_BASE_URL` in the reviewed private deployment config. Deploy the same
   code/config/schema combination and verify the health/config gate again.
5. Verify the bot identity with `getMe`. Register exactly one webhook at:
   `https://<PUBLIC_HOST>/api/webhooks/telegram`, with the configured secret
   header and `allowed_updates=["message"]`. Use a secret-manager-backed
   request body or API client; do not put the token in shell history or a
   shared process list. The endpoint must not be redirected by Cloudflare
   Access, an origin proxy, or a trailing-slash rule.
6. Verify `getWebhookInfo` reports the intended URL, no pending-error backlog,
   and a recent successful delivery. Only then log in to FlareMail, generate a
   binding link, open it in the intended Telegram private chat, send `/start`,
   click **确认绑定**, and separately enable notifications.

Useful Bot API methods are `getMe`, `setWebhook`, `getWebhookInfo`, and
`deleteWebhook`. A webhook Bot must not also be polled with `getUpdates`; the
two modes conflict. Local and production deployments using the same Bot also
conflict, so use a separate development Bot or explicitly delete/re-register
the webhook during an approved local test.

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

Persistent D1 limits cover bind, confirm, test, unbind, and manual retry
actions, plus Bot/user/chat delivery scopes. Telegram 429 responses honor
`retry_after` with jitter. Temporary failures use bounded exponential backoff
and max attempts; 401/403 and other permanent failures become terminal
`failed` rows.

The UI shows candidate/active/enabled state, privacy and summary switches,
test action, unbind action, recent deliveries, and manual retry warnings. API
responses are the normal `{ ok, data, requestId }` no-store envelope.

For local Worker preview, use the Wrangler local scheduled endpoint for the
configured Cron expression after starting the preview Worker. This proves only
local code, local D1, and injected/fake fetch behavior. It is not evidence of
Cloudflare Cron execution or Telegram delivery.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| `401` webhook | Secret header, exact route, no proxy rewrite, no Access challenge, and no redirect |
| `TELEGRAM_NOT_READY` | Enabled var, Bot token/username, webhook secret, HTTPS `APP_BASE_URL`, and schema 19 |
| Bot never sees `/start` | `getWebhookInfo`, webhook URL, pending errors, Bot blocked by the user, and production/local Bot conflict |
| Candidate expires | Generate a new link and send `/start` from the same private chat within 10 minutes |
| Confirm fails | The candidate update was not accepted, the chat is not private, or the candidate was replaced |
| No new notification | Confirmed binding, enabled switch, trusted `login_email` recipient, deleted state, D1 outbox status, and Cron backlog |
| Telegram `403` | The user blocked the Bot or the chat is no longer reachable; the row is terminal until the user rebinds |
| Telegram `429` | Inspect persistent Bot/user/chat cooldowns and wait for the stored retry time |
| `unknown_delivery` | Do not assume absence. Inspect Telegram manually, then use the UI's warned manual retry only if a duplicate is acceptable |
| Schema/readiness failure | Apply migrations in order, verify schema version 19 and all Telegram tables, then rerun health locally |
| `getUpdates` conflict | Delete polling or webhook mode and use only one update transport for this Bot |

Do not treat `/api/health = 200`, local unit/integration tests, a mocked
`fetch`, or a local scheduled invocation as proof of real Telegram delivery.
Real delivery evidence requires an explicitly approved production binding and
operator-observed Bot API response, and should record only safe metadata—not
tokens, message bodies, raw MIME, chat IDs, or secrets.
