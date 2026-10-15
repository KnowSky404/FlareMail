# User guide

[Project overview](../README.md) · [简体中文介绍](../README.zh-CN.md) · [Documentation index](./README.md)

## Domains and addresses

Open **Domains** or **Email addresses** from the sidebar. Each page starts with a table of the resources already saved for the Owner. Use the **Add domain** or **Add address** button for a dialog; edit an existing row from its accessible Edit pencil action. Refresh reads the saved list and keeps the current table context. A failed read is shown as an error instead of an empty configuration.

Use Previous page and Next page to navigate the tables; changing search, sort, or filters returns to the first page.

Use the domain and state filters to narrow the table. The domain address count includes every non-deleted address, including disabled addresses. Selecting **View addresses** applies that domain as a real address-list filter. Deleted addresses are available through the explicit deleted-state filter and expose only the recovery and diagnostics actions that apply to a tombstone.

Both tables start with 10 rows per page. Use **Rows per page** in the footer to choose 10, 20, 50, or 100. Changing the size returns to the first page and keeps your search, filters, and sort order. Reloading the browser page restores the default size.

Use **Sync Cloudflare configuration** only when you want to discover eligible provider configuration and import identity records locally. It is separate from Refresh and does not modify remote routes. Sync results can be complete, partial, failed, or unknown; review the result and resource state before retrying a write.

If a domain status check times out or otherwise has an uncertain result, the page reads the saved state again and keeps that domain's Check action locked while the result remains unknown. Refresh after the provider state is available to clear the lock.

The address dialog previews the complete address and supports optional display name and signature settings. Confirm that its receiving rule is ready before using it for inbound mail. Sending requires an enabled address/domain and verified Resend sending configuration. The workspace keeps receiving lifecycle, sending permission, provider readiness, and route state separate.

Deleting an address first shows a read-only preview of its routing rules and catch-all behavior. Review the offered route policy before confirming. Historical mail and attachments remain available. Removing an exact rule does not block another external catch-all.

Unknown recipients are rejected by default for manually connected domains. Collection requires a verified catch-all targeting this Worker; newly synced catch-all domains can start with collection enabled. See [domain setup](./PREVIEW.md) and the [identity API](./API.md#managed-domains-and-addresses) for configuration and policy details.

## Read and organize mail

- The inbox opens as a full-width list. Select a message to read it and return to the same filter. On desktop, the header control can show an optional reading pane; focused reading and standalone message links are also available.
- Inbox tabs include **All**, **Primary**, **Promotions**, **Social**, **Updates**, and **Forums**. Automatic categories use local sender/subject matching. Select messages to change their category or reset automatic classification.
- Filter by domain/address, search, or change pages. The selected identity applies to messages, drafts, counts, and search results.
- Opening received mail marks it read, including the reading pane and direct links.
  Marking it unread while reading keeps it unread until you close and reopen it.
  The Inbox badge shows unread received mail in the selected domain/address,
  independent of category and search. Sidebar and mobile menu badges show work
  needing attention: Inbox unread mail, all Drafts, and Sent mail that is sending,
  delayed, failed/suppressed, bounced, or complained. Normally sent/delivered mail
  is excluded. Starred, Archive, and Trash have no badges. Zero counts are hidden;
  counts above 99 show `99+`, with the full count in the accessible description.
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

Mail folders, categories, search, Starred, and label views show up to 40 mail records per page. Conversation grouping can produce fewer rows or show the same conversation on adjacent pages. Previous page restores a visited page; Next page replaces the current list. Bulk selection and default actions apply to the current page. Explicit filtered-conversation or Owner-conversation expansion remains available; turning a page clears both selection and the expansion choice. Trash also shows 40 records per page. A refresh or change of query restarts server pagination at the first page.

## Settings and notifications

Open Settings from the desktop sidebar or mobile navigation. The top-right account menu shows your account information, **About**, and **Sign out**. About opens a centered dialog with the project version, GitHub repository link, and `© KnowSky404` attribution. The version follows `package.json`; it does not include deployment identifiers. Close it with its Close button, Escape, or the backdrop; focus returns to the account button and unsaved settings remain intact.

Settings has five tabs: Profile, Notifications, Appearance, Diagnostics, and Telegram. Only the selected tab is shown. Switching tabs keeps unsaved inputs; Profile and Notifications each save their own fields. Appearance applies immediately, and Telegram uses its own actions. Diagnostics includes shortcuts to Domains and Email addresses.

Use the global language control in desktop Display preferences or the mobile navigation drawer. Choose English, Simplified Chinese, or the browser's language. Interface dates, counts, and accessibility labels follow the chosen language; original mail content remains unchanged.

On desktop, open Display preferences in the top-right corner to choose a theme, density, or language directly from the option cards. Each group has one Tab stop; arrow keys switch choices, Home/End select the first/last choice, and Escape closes the panel. Language preferences persist across reloads. The circular service-status icon opens workspace status details; green indicates healthy status and red indicates attention is needed.

Telegram notifications are optional. An operator configures the deployment Bot, then the Owner binds a private chat through a one-time confirmation link and chooses privacy/summary settings. Use the [Telegram guide](./TELEGRAM.md) for setup, retries, and delivery troubleshooting.
