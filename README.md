# FlareMail

English | [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail logo" width="286" />
</p>

A personal, self-hosted mail workspace on Cloudflare Workers. Manage multiple domains and mail addresses from one responsive inbox, with an English and Simplified Chinese interface.

## Features

- **Receive and send mail** — Cloudflare Email Routing for inbound mail, Resend for outbound mail, attachments, and delivery tracking.
- **Manage mail identities** — sync existing Cloudflare routing configuration, manage domains and addresses, and choose sender identities and signatures. Domains support batch checks and automatic health refresh.
- **Organize your inbox** — categories, labels, stars, archive, trash, blocked senders with recoverable quarantine, advanced search, bulk actions, and navigation counts for unread mail and drafts.
- **Read and compose anywhere** — desktop and mobile layouts, an optional reading pane, focused reading, replies, forwarding, and autosaved drafts.
- **Keep control of access and data** — local username/password or Cloudflare Access authentication, D1 for structured data, and R2 for raw mail and attachments.
- **Stay notified** — acknowledge delivery issues in the workspace notifications menu and revisit them in history. Optional Telegram notifications support privacy settings and delivery retries.

## Get started

Cloudflare commands use the globally installed `cf` CLI (Node.js ≥ 22.18). Install it with `bun add --global cf`; Wrangler is retired as a direct CLI. See [deployment](./DEPLOY.md) for the two-stage build and target migration.

For self-hosting, follow the [deployment guide](./DEPLOY.md). You will need a Cloudflare account, a domain configured for Email Routing, and Resend for outbound mail.

See the [development guide](./docs/DEVELOPMENT.md) for Bun, local fixtures and
a demo mail provider. GitHub Actions runs checks from the pinned CI baseline.

Mail addresses are managed resources under one workspace Owner; login credentials and profile email are configured separately.

Use a dedicated worktree and the [development workflow](./docs/WORKFLOW.md)
to choose CI, review and Preview gates by risk. Preview and production
deployments require separate authorization.

## Documentation

| Guide | What it covers |
| --- | --- |
| [User guide](./docs/USER_GUIDE.md) | Everyday mail, identities, search, and settings |
| [Local development](./docs/DEVELOPMENT.md) | Setup, administrator bootstrap, and verification |
| [Deployment](./DEPLOY.md) | First deployment, upgrades, and rollback |
| [Maintenance and recovery](./docs/DEPLOYMENT.md) | Backups, search indexes, cleanup, and recovery |
| [Inbound reliability](./docs/specs/inbound-delivery-reliability.md) | Ingest conflicts, plus aliases, routing scope, and delivery evidence |
| [Telegram](./docs/TELEGRAM.md) | Bot setup and notification operations |
| [Logo downloads](./docs/brand/README.md) | Telegram avatars, SVG/PNG/JPG/PDF, and a brand kit ZIP |
| [All documentation](./docs/README.md) | API, architecture, previews, design, and release records |

## License

FlareMail is licensed under the [GNU Affero General Public License](./LICENSE),
version 3 or (at your option) any later version (`AGPL-3.0-or-later`).

## HTML message rendering

The reader switches between Plain text and Safe HTML using a segmented control.
Safe HTML preserves common email typography, colors, table layouts and responsive
width rules on an isolated light canvas while blocking remote images. Open Display
options to load HTTPS images for the current message or block them again. Switching
messages resets the selection. Both HTML modes sanitize content and block scripts,
forms, frames and CSS resource loads. Mode explanations live behind the toolbar's
information icon, with hover, keyboard and touch access. Sender, delivery and technical details
open from a compact control in the message header, leaving more room for the body.
See the [HTML safety boundary](docs/API.md#html-safety-boundary).

The approach follows the presentation/CSS separation in
[Roundcube](https://github.com/roundcube/roundcubemail/blob/master/program/lib/Roundcube/rcube_washtml.php)
and [SnappyMail](https://github.com/the-djmaze/snappymail/blob/master/dev/Common/Html.js),
using [CSSTree](https://github.com/csstree/csstree) for CSS parsing and validation
and [parse5](https://github.com/inikulin/parse5) for HTML5 structure normalization.

Optional shared AI summaries with workspace output language, opt-in automatic Telegram summaries and automatic new-mail classification into six purpose categories: [AI setup and privacy guide](docs/AI.md). Disabled by default. Configure the model/key in **Settings → AI settings**; Chat Completions and Responses API are supported.
