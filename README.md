# FlareMail

English | [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail logo" width="286" />
</p>

A personal, self-hosted mail workspace on Cloudflare Workers. Manage multiple domains and mail addresses from one responsive inbox, with an English and Simplified Chinese interface.

## Features

- **Receive and send mail** — Cloudflare Email Routing for inbound mail, Resend for outbound mail, attachments, and delivery tracking.
- **Manage mail identities** — sync existing Cloudflare routing configuration, manage domains and addresses, and choose sender identities and signatures.
- **Organize your inbox** — categories, labels, stars, archive, trash, advanced search, bulk actions, and navigation counts for unread mail, drafts, and sending or failed mail.
- **Read and compose anywhere** — desktop and mobile layouts, an optional reading pane, focused reading, replies, forwarding, and autosaved drafts.
- **Keep control of access and data** — local username/password or Cloudflare Access authentication, D1 for structured data, and R2 for raw mail and attachments.
- **Stay notified** — optional Telegram notifications with privacy settings and delivery retries.

## Get started

Cloudflare commands use the globally installed `cf` CLI (Node.js ≥ 22.18). Install it with `bun add --global cf`; Wrangler is retired as a direct CLI. See [deployment](./DEPLOY.md) for the two-stage build and target migration.

For self-hosting, follow the [deployment guide](./DEPLOY.md). You will need a Cloudflare account, a domain configured for Email Routing, and Resend for outbound mail.

For local development, use the [development guide](./docs/DEVELOPMENT.md). Use the newest stable Bun already installed locally (minimum **1.4.0**). Tests and deployments run locally; GitHub scans dependencies when a Release is published or the workflow is run manually, using the Bun version in `package.json`. A local demo mail provider is included.

Mail addresses are managed resources under one workspace Owner; login credentials and profile email are configured separately.

Develop every change in a dedicated worktree and new branch. Before each task
push and again before PR creation, run local `/review` and resolve all valid
findings. Feature changes also require remote PRE acceptance before a PR to
`main`. All PRs wait for Code Review and Security Review of the current head and
resolution of findings, then use rebase merge, main synchronization and merged
task worktree/branch cleanup. These Git steps proceed by default unless the user
restricts the task; Preview and production deployment need separate authorization.
See the
[development workflow](./docs/DEVELOPMENT.md#worktree-and-pr-workflow).

## Documentation

| Guide | What it covers |
| --- | --- |
| [User guide](./docs/USER_GUIDE.md) | Everyday mail, identities, search, and settings |
| [Local development](./docs/DEVELOPMENT.md) | Setup, administrator bootstrap, and verification |
| [Deployment](./DEPLOY.md) | First deployment, upgrades, and rollback |
| [Maintenance and recovery](./docs/DEPLOYMENT.md) | Backups, search indexes, cleanup, and recovery |
| [Inbound reliability](./docs/specs/inbound-delivery-reliability.md) | Ingest conflicts, plus aliases, routing scope, and delivery evidence |
| [Telegram](./docs/TELEGRAM.md) | Bot setup and notification operations |
| [All documentation](./docs/README.md) | API, architecture, previews, design, and release records |

## License

FlareMail is licensed under the [GNU Affero General Public License](./LICENSE),
version 3 or (at your option) any later version (`AGPL-3.0-or-later`).
