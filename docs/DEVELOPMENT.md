# Local development

[Project overview](../README.md) · [简体中文介绍](../README.zh-CN.md) · [Documentation index](./README.md)

## Prepare the checkout

Use the newest stable Bun already installed on your machine, satisfying
`engines.bun` in `package.json` (currently **>=1.4.0**). Do not download an older
runtime just to match `packageManager`: that field records the reproducible CI
baseline, currently **1.4.2**, and CI reads it directly. Release preflight checks
the stable runtime against the engine minimum, rather than requiring equality
with the CI baseline. This policy does not automatically upgrade the machine's
Bun installation or project dependencies. From the repository root:

```bash
bun --version
bun install --frozen-lockfile
bun run audit:dependencies
bun run db:migrate:local
```

The checked-in `wrangler.toml` uses local D1/R2, `AUTH_MODE=local`, and the demo outbound provider with `ALLOW_FAKE_SERVICES=true`. Optional local overrides belong in the ignored `.dev.vars`; see `.dev.vars.example`. Keep real credentials out of Git.

The workflow is local implementation and verification, then an authorized remote Preview deployment, then a separately authorized production release. Ordinary development does not automatically deploy. The repository's configured preview environments share production D1/R2 and the Owner account; writes there affect production. Use local state for development and read the [preview guide](./PREVIEW.md) before using a remote preview. Production uses Resend and rejects missing required bindings or secrets.

## Initialize the local Owner

There is no default login password. Set these variables in the current shell and choose your own password of at least 12 characters:

```bash
export FLAREMAIL_ADMIN_USERNAME='flower'
export FLAREMAIL_ADMIN_NAME='FlareMail Administrator'
export FLAREMAIL_ADMIN_PASSWORD='replace-with-your-own-long-password'
bun run auth:bootstrap:local
unset FLAREMAIL_ADMIN_USERNAME FLAREMAIL_ADMIN_NAME FLAREMAIL_ADMIN_PASSWORD
```

Keep the password out of project `.env` files. `FLAREMAIL_PROFILE_EMAIL` is optional profile data and grants no send or receive rights. For an Access-only Owner, use `bun run auth:bootstrap:access` with no local username/password variables; configure Cloudflare Access using the [deployment guide](../DEPLOY.md).

## Run the application

Choose the SvelteKit development server for page work or the built Worker preview for Worker handlers and local mail testing:

```bash
bun run dev --host :: --port 5173
```

```bash
bun run preview --ip :: --port 8787
```

`::` enables IPv6 and, on systems with dual-stack sockets, IPv4. On this project's VPS, open `http://oc-de-fra-1.knowsky.uk:5173` or `http://oc-de-fra-1.knowsky.uk:8787`. Check the actual listener with `ss -lntp` if remote access fails; a local-only listener is insufficient for browser access from another machine. `bun run preview` is a local Worker process; it does not publish a remote Preview.

### Test inbound mail locally

The Worker preview runs `email()`; the SvelteKit development server alone does not. Configure a local test domain with `bun run mail:domain:configure`, then add an enabled address through mail identity settings or a test fixture. Follow the domain configuration inputs in `.dev.vars.example`.

POST a complete RFC5322 message as the request body to `/cdn-cgi/handler/email?from=...&to=...`. The body must be raw mail, rather than JSON. The envelope `to` must match an enabled managed address or a verified domain collection policy. Login usernames and profile emails do not determine inbound ownership.

The demo/fake provider validates the UI, persistence, and mail state transitions locally. It does not contact Resend or establish real delivery. Production delivery is tracked through signed Resend webhooks; see [deployment](../DEPLOY.md).

## Verify changes

For code, tests, or runtime configuration changes, run these gates in order
before committing. Pure documentation changes need diff, command and link
review; changes to validation scripts or CI still require the code gates:

```bash
bun run test
bun run check
bun run build
```

For browser interaction changes, install the Playwright browser binaries if needed, then run the relevant suites:

```bash
bunx playwright install --with-deps chromium webkit firefox
bun run test:e2e
bun run test:e2e:webkit
bun run test:e2e:firefox
bun run test:a11y
```

Browser tests create isolated D1/R2 state in the operating system's temporary directory and use fake providers and signed test webhooks. Run check, typegen, build, dry-run and browser suites sequentially because they share generated output. Use separate worktrees and test state directories for concurrent verification. Linux WebKit results cover simulated viewports, rather than physical iOS/iPadOS Safari devices. Missing browser binaries are a test environment failure.

`bun run deploy:dry-run` builds a temporary configuration from the public development config without reading the private production config or publishing a Worker. Local checks do not establish production deployment, remote migration, or real mail/Telegram delivery.

Publish the verified commit to remote Preview only when deployment is requested
or already authorized, following [PREVIEW.md](./PREVIEW.md). Record the SHA, URL,
deployment/version ID and relevant checks; confirm production traffic still
points to its previous deployment. Shared Preview data is read-only for ordinary
acceptance checks; writes and real provider tests require authorization covering
their production effects. Production publication follows the
[production checklist](./PRODUCTION_CHECKLIST.md), with Preview evidence or a
documented alternative when Preview cannot cover the changed handler.

## Repository map

| Path | Responsibility |
| --- | --- |
| `worker/index.ts` | Worker entry point: web/API `fetch`, inbound `email`, and scheduled tasks |
| `src/routes/` | SvelteKit pages, thin API routes, and the standalone message reader |
| `src/lib/domain/mail/` | Mail contracts, threading, compose, delivery state, and validation |
| `src/lib/server/` | Authentication, D1/R2, inbound/outbound mail, and workspace operations |
| `src/lib/components/` | Shared UI, shell, and mail components |
| `src/lib/i18n/` | English/Simplified Chinese catalogs and locale handling |
| `migrations/` | Ordered D1 migrations; apply these to initialize or upgrade a database |
| `schema.sql` | Latest schema snapshot |

`build/`, `.svelte-kit/`, and `.wrangler/` are generated output. The repository supports tests from a clean checkout without requiring an earlier build.

Wrangler-generated `worker-configuration.d.ts` is the binding type authority. When changing the runtime version, keep `wrangler.toml`, `wrangler.build.toml`, and `wrangler.deploy.toml.example` aligned and regenerate types with `bun run cf:typegen`.

For API contracts, design rules, and operational procedures, use the [documentation index](./README.md).
