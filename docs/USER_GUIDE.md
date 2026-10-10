# User guide

[Project overview](../README.md) · [简体中文介绍](../README.zh-CN.md) · [Documentation index](./README.md)

## Domains and addresses

Open **Domains** or **Mail addresses** from the sidebar. When provider credentials are configured, FlareMail syncs existing Cloudflare rules pointing to this application. You can retry with **Sync Cloudflare configuration** or connect another domain manually. Sync reads remote rules and saves identity records locally; it preserves existing names, signatures, disabled states, and deleted addresses.

Use an address prefix on a domain card to create an address. Confirm that its receiving rule is ready before using it for inbound mail. Address names and signatures can be edited separately. Sending requires an enabled address/domain and verified Resend sending configuration. The workspace explains unavailable or stale sender states.

Deleting an address first shows a read-only preview of its routing rules and catch-all behavior. Review the offered route policy before confirming. Historical mail and attachments remain available. Removing an exact rule does not block another external catch-all.

Unknown recipients are rejected by default for manually connected domains. Collection requires a verified catch-all targeting this Worker; newly synced catch-all domains can start with collection enabled. See [domain setup](./PREVIEW.md) and the [identity API](./API.md#managed-domains-and-addresses) for configuration and policy details.

## Read and organize mail

- The inbox opens as a full-width list. Select a message to read it and return to the same filter. On desktop, the header control can show an optional reading pane; focused reading and standalone message links are also available.
- Inbox tabs include **All**, **Primary**, **Promotions**, **Social**, **Updates**, and **Forums**. Automatic categories use local sender/subject matching. Select messages to change their category or reset automatic classification.
- Filter by domain/address, search, or change pages. The selected identity applies to messages, drafts, counts, and search results.
- Opening received mail marks it read, including the reading pane and direct links.
  Marking it unread while reading keeps it unread until you close and reopen it.
  The Inbox badge shows unread received mail in the selected domain/address,
  independent of category and search.
- Returning to a recently visited mailbox/category restores the cached list and
  loaded pages immediately. Older views refresh in the background; use Refresh
  to fetch changes immediately.
- Star messages, mark them read/unread, archive them, or move them to Trash. A recent delete can be undone; messages in Trash can be restored. Trash spans the Owner's workspace.
- Create, rename, or delete labels from the sidebar. Labels and Starred provide views across folders. Bulk label changes apply to selected messages on the current page.
- Bulk actions normally affect selected loaded messages. Thread-wide operations require an explicit scope choice. Selections containing drafts have fewer available actions.

Inbox categories require migration `0028_inbox_categories.sql`. Apply the current ordered migrations through the [deployment procedure](../DEPLOY.md); the repository's migration files do not establish that a remote database has been upgraded.

## Search

Use keywords or combine advanced filters:

```text
from:alice@example.com subject:invoice attachment:yes
to:hello@example.com date:2026-10-01
```

Supported filters include `from:`, `to:`, `subject:`, `date:`, and `attachment:yes|no`. A date selects that UTC day. Address scope and pagination still apply. See the [search API contract](./API.md#mailbox-search) for syntax and searchable content.

## Compose and send

Start a new message, reply, forward, or open a draft to continue editing. Received and sent message bodies remain historical records; edits belong in a new message or draft.

For new mail, FlareMail prefers a ready sender matching the selected exact address, otherwise the ready global default. Replies and drafts retain their saved identity. Check the sender and its signature before sending.

The editor supports To/Cc/Bcc recipients, attachment uploads, and autosaved drafts. Recent-contact suggestions come from mail already loaded in the current session. Desktop compose can be moved, resized, minimized, or maximized; mobile compose uses the full screen. The HTML source option starts collapsed.

Use the delivery timeline to review submission, delivery, and failure events. Submission to Resend is separate from confirmed delivery. If the login session expires, keep the compose tab open, sign in again, and review the action before retrying.

## Settings and notifications

Settings groups profile, notifications, appearance, diagnostics, and Telegram controls. Choose English, Simplified Chinese, or the browser's language. Interface dates, counts, and accessibility labels follow the chosen language; original mail content remains unchanged.

On desktop, open Display preferences in the top-right corner to choose a theme, density, or language directly from the option cards. Each group has one Tab stop; arrow keys switch choices, Home/End select the first/last choice, and Escape closes the panel. Language preferences persist across reloads. The circular service-status icon opens workspace status details; green indicates healthy status and red indicates attention is needed.

Telegram notifications are optional. An operator configures the deployment Bot, then the Owner binds a private chat through a one-time confirmation link and chooses privacy/summary settings. Use the [Telegram guide](./TELEGRAM.md) for setup, retries, and delivery troubleshooting.
