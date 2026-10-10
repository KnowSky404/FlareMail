# FlareMail

English | [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./static/brand/flaremail-logo.svg" alt="FlareMail logo" width="286" />
</p>

A personal, self-hosted mail workspace on Cloudflare Workers. Manage multiple domains and mail addresses from one responsive inbox, with an English and Simplified Chinese interface.

## Features

- **Receive and send mail** — Cloudflare Email Routing for inbound mail, Resend for outbound mail, attachments, and delivery tracking.
- **Manage mail identities** — sync existing Cloudflare routing configuration, manage domains and addresses, and choose sender identities and signatures.
- **Organize your inbox** — categories, labels, stars, archive, trash, advanced search, and bulk actions.
- **Read and compose anywhere** — desktop and mobile layouts, an optional reading pane, focused reading, replies, forwarding, and autosaved drafts.
- **Keep control of access and data** — local username/password or Cloudflare Access authentication, D1 for structured data, and R2 for raw mail and attachments.
- **Stay notified** — optional Telegram notifications with privacy settings and delivery retries.

## Get started

For self-hosting, follow the [deployment guide](./DEPLOY.md). You will need a Cloudflare account, a domain configured for Email Routing, and Resend for outbound mail.

For local development, use the [development guide](./docs/DEVELOPMENT.md). Use the newest stable Bun already installed locally (minimum **1.4.0**). Tests and deployments run locally; GitHub scans dependencies when a Release is published or the workflow is run manually, using the Bun version in `package.json`. A local demo mail provider is included.

Mail addresses are managed resources under one workspace Owner; login credentials and profile email are configured separately.

Develop each task in a dedicated worktree and new branch. Feature changes pass
local checks and remote PRE acceptance before a PR to `main`; merge and
production deployment follow explicit authorization. Authorized PRs use rebase
merge by default, followed by main synchronization and completed task
worktree/branch cleanup. See the
[development workflow](./docs/DEVELOPMENT.md#worktree-and-pr-workflow).

## Documentation

| Guide | What it covers |
| --- | --- |
| [User guide](./docs/USER_GUIDE.md) | Everyday mail, identities, search, and settings |
| [Local development](./docs/DEVELOPMENT.md) | Setup, administrator bootstrap, and verification |
| [Deployment](./DEPLOY.md) | First deployment, upgrades, and rollback |
| [Maintenance and recovery](./docs/DEPLOYMENT.md) | Backups, search indexes, cleanup, and recovery |
| [Telegram](./docs/TELEGRAM.md) | Bot setup and notification operations |
| [All documentation](./docs/README.md) | API, architecture, previews, design, and release records |

## License

[GNU Affero General Public License v3.0 only](./LICENSE) (`AGPL-3.0-only`).
