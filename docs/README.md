# Documentation

[English overview](../README.md) · [简体中文介绍](../README.zh-CN.md)

The project overview is available in both languages. Detailed guides currently use English or Chinese as marked below.

## Use and operate FlareMail

| Document | Language | Purpose |
| --- | --- | --- |
| [User guide](./USER_GUIDE.md) | English | Domains, addresses, daily mail actions, search, compose, and settings |
| [Local development](./DEVELOPMENT.md) | English | Local setup, Owner bootstrap, Worker preview, tests, and repository structure |
| [Deployment](../DEPLOY.md) | English | Authoritative first production deployment, upgrades, Custom Domains, Resend, Email Routing, and rollback |
| [Preview and domain setup](./PREVIEW.md) | 中文 | Preview environments, shared production data, provider credentials, and browser domain setup |
| [Maintenance and recovery](./DEPLOYMENT.md) | English | Read-only audits, identity backfill, retention, R2 cleanup, FTS export, and incident recovery |
| [Production checklist](./PRODUCTION_CHECKLIST.md) | English | Release gates, migration review, provider checks, and rollback readiness |
| [Telegram](./TELEGRAM.md) | English | Bot setup, binding, webhooks, outbox, Cron, privacy, and troubleshooting |

Use [DEPLOY.md](../DEPLOY.md) for deployment order and the current checkout's `migrations/` for schema changes. Historical acceptance records describe their original release and verification scope.

## Build and understand the application

| Document | Language | Purpose |
| --- | --- | --- |
| [Navigation and read-state spec](./specs/mailbox-navigation-and-read-state.md) | 中文 | Cache behavior, unread counters, partial state writes and acceptance |
| [Workspace API](./API.md) | English | Authentication, identity management, mailbox pagination, search, drafts, mutations, and delivery contracts |
| [Owner, identities, and Access ADR](./adr/0014-owner-managed-mail-identities-and-access.md) | English | Authentication and mail ownership architecture |
| [Body storage ADR](./adr/0011-body-storage.md) | English | Mail body storage decisions |
| [FTS5 search ADR](./adr/0012-fts5-search.md) | English | Search projection and index decisions |
| [Outbound attachments ADR](./adr/0013-outbound-attachments.md) | English | Attachment sending decisions |
| [Design system](../DESIGN.md) | 中文 | Visual design, responsive behavior, and accessibility rules |
| [Brand assets](./design-concepts/flaremail-logo/README.md) | English | Logo, favicon, and design sources |
| [Runtime budget](./RUNTIME_BUDGET.md) | English | Worker CPU budget and preview measurements |
| [Proposed SLOs](./SLO.md) | English | Reliability objectives and observability expectations |
| [Roadmap](../TODO.md) | 中文 | Remaining product work |

## Review and historical records

| Document | Language | Purpose |
| --- | --- | --- |
| [UI/UX review](./UI_UE_REVIEW.md) | 中文 | Implemented UI changes, acceptance scope, and verification records |
| [Reading-space QA](./READING_SPACE_QA.md) | 中文 | Layout contracts, browser results, and evidence limits |
| [September acceptance](./ACCEPTANCE_2026-09.md) | 中文 | Reliability fixes and verification for the recorded release |
| [RC-1 record](./RC1_RELEASE.md) | English | Historical behavior, schema, and release risks |
| [Refactor plan](../REFACTOR_PLAN.md) | 中文 | Implementation phases, rollback points, and acceptance boundaries |
