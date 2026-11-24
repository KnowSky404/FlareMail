# Optional AI mail assistance / 可选 AI 邮件辅助

AI is **off by default**. Opening mail reads only the shared analysis cache and displays a valid summary automatically. Explicit manual generation, separately authorized Telegram summaries and separately authorized automatic classification use the same bounded analysis/provider/quota. Sending and receiving remain independent of AI.

AI **默认关闭**。打开邮件只读取共享缓存，有有效摘要即展示；手动生成、独立授权的 Telegram 自动摘要和自动分类共用一次分析及额度，不影响收发信持久化。

## Enable / 启用

1. Follow the existing [Preview](PREVIEW.md) and [production checklist](PRODUCTION_CHECKLIST.md)
   before publishing. Migration `0030_mail_ai_analyses.sql` adds the cache, quota
   and deletion triggers at schema 30; migration `0031_telegram_ai_summary.sql`
   adds automatic Telegram consent at schema 31. Migration `0032_ai_automatic_classification.sql` adds the six-purpose categories, durable classification jobs and last-success timestamps at schema 32. The current application requires schema 35. See the [delivery attention cutover](PRODUCTION_CHECKLIST.md#schema-35-delivery-attention-upgrade) before upgrading a shared database. Run all migrations locally
   with `bun run db:migrate:local`. Remote migration and deployment require their
   own authorization; this guide does not execute them.
2. Create one cryptographically random 32-byte encryption key (64 hexadecimal
   characters) for each independently stored Owner settings record. All targets
   sharing that Owner's settings in D1 **must use the identical AI_SETTINGS_KEY
   value**, configured as a Worker/Preview Secret and declared in each ignored
   target's `secrets` list. A native Preview needs its own Secret binding; it
   does not inherit production secrets. Do not generate a different value for
   a Preview sharing production D1: either target would fail to decrypt the
   other's saved key. Only an isolated D1/settings store can use an independent
   encryption key. Keep the value stable across deployments, outside D1 and Git.
   With shared D1, saving AI settings also changes production settings; follow
   the existing Preview write-authorization rules.
3. Sign in as the workspace **Owner**, open **Settings → AI settings**, enter
   the API base URL, model and API key, choose **Chat Completions** or
   **Responses API**, enable AI, and save. Changes apply immediately without
   redeployment. Saving does not call the provider. No new database or bucket
   is needed: public options and an AES-GCM encrypted key use the existing
   `workspace_settings` record. The encryption Secret stays outside D1.
4. A blank key preserves the current key; entering a value replaces it. Keys
   are never returned or prefilled. Changing the API base requires re-entering
   the key. To remove it, disable AI and select **Delete the saved API key**.
   Concurrent edits return `AI_SETTINGS_CONFLICT`; reload before saving again.
   Losing or rotating the encryption Secret requires entering a replacement
   provider key; the old encrypted value cannot be recovered without it.

The API base is a trusted public HTTPS address, such as
`https://api.your-provider.com/v1`. Full URLs ending in `/chat/completions` or
`/responses` are also accepted, with an optional trailing slash. The selected
API format determines the final endpoint; the method path is appended exactly
once. Stored URLs remain unchanged so existing encrypted keys remain readable.
Credentials, queries, fragments, IP literals, local names and nonstandard ports
are rejected; redirects are never followed. Workers uses `redirect: manual`
and rejects non-2xx responses; the Fetch-standard `error` mode is unsupported
by workerd and throws before any network request. Choose a provider you trust with
email contents. Hostname validation cannot prevent a trusted hostname's DNS
from resolving to an inappropriate destination.

中文：管理员为独立的 Owner 设置存储初始化一次 **AI_SETTINGS_KEY** 加密 Secret
（随机 32 字节，64 位十六进制）。共享同一 D1/Owner 设置的生产和 PRE 必须配置
**相同的密钥值**；只有 D1/设置完全隔离时才能使用独立密钥。原生 PRE 需要单独配置
Secret 绑定，但不能因此为共享数据重新生成不同的密钥。共享 D1 时保存配置也会影响
生产，仍须遵循 PRE 写入授权范围。后续 Owner 直接在「设置 → AI 设置」修改地址、模型、Key、接口格式、
超时和正文长度，保存立即生效，无需重新部署，也不会发起模型调用。复用现有设置表，
Key 经 AES-GCM 加密保存且永不回显；留空保留，填新值替换，更换地址须重新输入。
地址可填到 `/v1`，也可粘贴完整 `/responses` 或 `/chat/completions` 地址，
最终调用路径按所选接口格式确定，不会重复追加；已保存 Key 不受此兼容修复影响。
删除 Key 前先关闭 AI，再勾选删除。并发修改时重新读取配置后保存。加密 Secret 必须跨部署
保持稳定；丢失或轮换后需重新填写供应商 Key。原生 PRE 的 Secret 与生产环境分别配置。

For server-managed installations with no saved UI override, the existing
string variables remain supported: `AI_ENABLED`, `AI_PROVIDER` (only
`openai-compatible`), `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS` (default 15000),
`AI_MAX_INPUT_CHARS` (default 16000), `AI_API_FORMAT` (`chat-completions` by
default, or `responses`) and Secret `AI_API_KEY`. Once UI settings exist,
these defaults no longer override them, including the enable flag and key.
Never put plaintext provider keys in `vars`, D1, frontend files or Git.

Responses mode sends a non-streaming `POST /responses` with `instructions`,
`input`, `max_output_tokens` and `store: false`. Chat mode uses
`POST /chat/completions` with `messages` and `store: false`. Both validate the
same analysis JSON and limits. Responses must finish with `status: completed`
and assistant `output_text`; incomplete, refusal or tool output fails safely.
This is an outbound provider adapter, not a public OpenAI proxy endpoint.
See the [official Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

## OpenAI Platform / 官方平台

For an OpenAI Platform project, use its API key, set the API URL to
`https://api.openai.com/v1` (a full `/responses` URL also works), keep the model
ID available to that project, and select **Responses API** in AI settings.
`platform.openai.com` is the project management site; it is not the API base URL.

Requests to the exact `api.openai.com` origin use the official parameters:
Responses sends `instructions`, `input`, `max_output_tokens`, and strict JSON
Schema under `text.format`. Chat Completions uses `messages`,
`max_completion_tokens` and `response_format.json_schema`. Both use
`Authorization: Bearer`, `store: false`, and no streaming or tools. Third-party
compatible endpoints retain the existing request format. Local validation
still checks lengths, categories, language and verbatim date evidence.

官方平台配置：使用 OpenAI Platform 项目的 API Key，地址填
`https://api.openai.com/v1`（完整 `/responses` 地址也兼容），模型填写该项目
可访问的模型 ID，接口选择 Responses API。`platform.openai.com` 是管理站点，
不是 API 请求地址。官方直连接口使用严格 JSON Schema 输出，并分别按 Responses
和 Chat Completions 的官方字段发送请求；兼容服务保留原有请求格式。

The 1800 output-token cap includes reasoning for reasoning models. Model
reasoning defaults are preserved. Truncation/refusal never becomes a cached
analysis and does not trigger an automatic billable retry or a budget increase.
Only recognized upstream error codes are classified. Error responses never
return or log upstream messages, keys, project identifiers or echoed email text.

Reference: [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses),
[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[error codes](https://developers.openai.com/api/docs/guides/error-codes).

## Use / 使用

The shared AI panel in the mailbox, focused reader and standalone reader opens automatically and reads the owned cache. Switch between the **Summary** and **Category suggestion** tabs, or collapse the panel to make room for the original email. **About AI analysis** shows the provider disclosure, generation time and accuracy reminder on hover, focus or tap. Use **Agree and generate analysis** or **Agree and regenerate** in the panel header, then confirm the privacy notice to send a request. Opening the reader only reads the cache. A failed regeneration of identical input retains the previous successful analysis, including after a page reload.

在邮箱、专注阅读或独立阅读中打开邮件，AI 面板默认展开并读取缓存。可在「摘要」和「分类建议」页签间切换，也可折叠面板腾出正文空间。悬停、聚焦或点击「关于 AI 分析」可查看外部处理说明、生成时间和准确性提醒。点击面板右上角的「同意并生成分析」或「同意重新生成」并确认隐私提示后，才会发出生成请求。打开邮件只读取缓存。相同输入重新生成失败时保留上次成功结果，刷新后仍可查看。

Manual application uses **Confirm and apply category** and the existing inbox PATCH API; it records a manual choice. Existing manual choices, including concurrent changes in another tab, take priority. Restore automatic classification in the inbox controls to remove that override. The cache is invalidated by changes to the effective output language, model, endpoint, API format, input limit, prompt/schema or canonical body. Permanent deletion cleans up analysis and pending jobs.

「确认应用此分类」通过原有接口保存人工选择；人工选择优先，另一标签页的并发设置也受保护。通过收件箱菜单恢复自动分类可清除人工覆盖。输出语言、模型、服务地址、接口格式、输入上限、Prompt/Schema 或完整正文变化都会使摘要缓存失效。永久删除同时清理分析及后台任务。

## Summary language / 摘要语言

Choose **Use workspace language** (default), Simplified Chinese, English, or a custom BCP 47 tag such as `ja` or `zh-TW`. Workspace mode uses the interface language captured when AI settings were last saved, defaulting to `zh-CN` for older settings. Web, Telegram and classification all use that same language. Changing interface language alone does not invalidate summaries; save AI settings again to change workspace output. Fixed/custom output remains independent of interface language. Legacy request `language` parameters remain validated for compatibility.

摘要语言可选择「使用工作区语言」、简体中文、English 或自定义代码（如 `ja`、`zh-TW`）。工作区模式统一使用保存 AI 设置时的界面语言，旧设置默认 `zh-CN`。网页、Telegram 和自动分类共用该语言；仅切换界面语言不会使摘要失效，需要重新保存 AI 设置才更新输出语言。固定/自定义语言不跟随界面。

## Automatic classification / 自动分类

In **Settings → AI settings**, separately enable **Automatically classify new mail** and save after reading the external-processing/usage notice. It defaults off and does not require Telegram. Only mail arriving during that authorization is queued; older mail is not scanned. Cron reuses an existing valid analysis or generates one, then stores its category only while the message remains eligible and no manual override exists. Disable the switch/global AI to stop new requests; re-enabling does not authorize older queued work. Content already sent to a provider cannot be recalled.

「设置 → AI 设置」单独开启「自动分类新邮件」并保存，即同意将新邮件的有限内容发送到当前服务商并消耗额度。默认关闭、不依赖 Telegram、不回填历史。Cron 优先复用分析，只有在邮件仍可处理且没有人工分类时才保存 AI 类别。关闭开关或全局 AI 可停止新调用；再次开启不会扩大旧任务权限。已经发送给服务商的内容无法撤回。

| Category / 分类 | Purpose / 用途 |
| --- | --- |
| primary / 主要往来 | Personal/work correspondence and human replies / 私人及工作沟通、人工回复 |
| transactions / 交易账务 | Orders, invoices, payments, refunds, shipping / 订单、账单、支付、退款、物流 |
| security / 账号安全 | Verification, login and password alerts / 验证码、登录、密码提醒 |
| updates / 服务通知 | Service/product/platform activity notices / 服务变更与平台互动提醒 |
| subscriptions / 订阅资讯 | Editorial newsletters, articles, community digests / 简报、文章、社区周报 |
| promotions / 营销推广 | Sales, coupons and advertising / 促销、优惠、广告 |

Manual override > AI category > local rules > primary. Security/transaction purpose takes precedence over incidental ads. Retired social/forums IDs normalize to updates; migrated manual choices remain manual and their raw values remain in legacy columns. Classification is not a spam, trust or security decision. Custom labels stay manual. Background failures fall back to rules and never delete/archive mail. Each job initiates at most one provider generation; unattempted busy/quota work may wait for capacity. Automatic classification, Telegram and manual analysis share the existing 30 attempts/hour/Owner limit.

优先级为人工覆盖 > AI 分类 > 本地规则 > 主要往来。安全及交易邮件不因夹带广告进入推广。旧社交/论坛归并为服务通知，人工状态及原始旧值保留。类别不代表可信度或垃圾邮件判断；自定义标签仍由人工管理。后台失败退回规则，每个任务最多发起一次模型生成；未发起调用的忙碌/限额任务可延后。三种入口共用每 Owner 每小时 30 次尝试。

See the [implementation SPEC](specs/ai-summary-and-automatic-classification.md) for schema 32 rollout and acceptance gates.

## Automatic Telegram summary / Telegram 自动摘要

In Telegram notification settings, separately enable **Automatic AI summary**
after reviewing the external-processing and usage notice. The switch defaults off;
the existing short-summary switch alone does not grant AI consent. Notifications
must be enabled, include summaries and have privacy mode off. Both queue-time and
current consent must permit AI; enabling it does not expand older queued messages.

The outbox reuses the same bounded body processing, provider, validated analysis,
cache and Owner quota. It sends only `analysis.summary` as a bounded plain-text
**AI summary**. AI failure, unavailable configuration, exhausted quota or an empty
body falls back to the original snippet. Privacy mode suppresses both kinds of
summary. Telegram itself does not apply categories or send a second message; independently authorized classification jobs can reuse the analysis.

If a shared analysis is in flight or another caller wins its claim, Telegram defers for at least five seconds and reads that result on a later dispatcher run. A delivery may initiate AI generation once; Telegram retries can reuse a ready
cache but never start another generation for that delivery. A timeout may already
be billed. Notification delivery does not retry an AI failure. The short inbound
dispatch budget defers eligible AI work to the scheduled dispatcher. Permission is
checked again before Telegram sends; revocation cannot recall content already
submitted to the provider.

Telegram 的「自动 AI 摘要」默认关闭，必须独立同意有限正文发送给已有 AI 服务及
额度/费用提示。还需启用通知、包含摘要并关闭隐私模式；入队时和发送前均须授权。
成功时推送标记为「AI 摘要」的有限纯文本；失败、未配置、超额或空正文退回原摘要。
同一通知最多发起一次 AI 生成，Telegram 重试只复用缓存，不重复自动计费请求。
Telegram 隐私模式始终不生成也不展示摘要；独立授权的自动分类不受 Telegram 开关影响。

Migration `0031_telegram_ai_summary.sql` adds default-off consent snapshots and a
single-attempt marker. See the [SPEC](specs/ai-language-and-telegram-summary.md)
and [Telegram guide](TELEGRAM.md) for rollout and acceptance. Remote migrations
are separate authorized operations; do not apply this schema upgrade against a
production deployment that only accepts schema 30.

## Privacy and limits / 隐私与限制

Only subject (512 characters), sender (320 characters) and bounded plain body
text are sent. Attachments, raw `.eml`, technical headers, recipient lists,
Cookies and secrets are excluded. HTML extraction never executes HTML or loads
remote resources and reads at most 128 KiB of HTML. Long bodies are truncated
and the UI states that coverage is incomplete. Empty bodies fail explicitly.
Dates must be verbatim body excerpts; AI may still misunderstand other facts.
Results render as plain text, never executable HTML or Markdown links.

Requests have a 15-second default total timeout (100–30000 ms), 16000-character
body limit (256–32000), 256 KiB outbound request cap, 1800 output tokens and
32 KiB response cap. Per-message generation has a 30-second cooldown and
60-second recoverable claim lease; each Owner has 30 attempts/hour. For manual analysis only, an
explicit `429` with `Retry-After: 0` is retried once. Background analyses do not
perform adapter retries, so revoked consent cannot be bypassed by a retry. Network errors, timeouts and
5xx responses are not automatically retried because they may already be billed.

仅发送必要主题、发件人及有限长度的纯文本，不发送附件、原始邮件、技术 Headers、
收件人列表或认证信息。长邮件有覆盖范围提示。日期必须直接出现在正文中，但其他摘要内容仍可能
被模型误解，请以原文为准。默认超时 15 秒、正文最多 16000 字符、输出最多 1800 Token、
响应最多 32 KiB。每封邮件冷却 30 秒，租约 60 秒可恢复；每 Owner 每小时最多 30 次尝试。手动分析仅对明确的 `429` / `Retry-After: 0` 重试一次；
后台分析不自动重试供应商请求，限流时退回原摘要。
隔离和黑名单邮件禁用 AI，草稿与已发送邮件暂不支持。

## Disable and troubleshoot / 禁用与排错

Turn off AI in **Settings → AI settings** and save to stop new provider calls; normal email rules continue. Saved analyses stay in D1
until their message is permanently deleted. Disablement is not provider-side
removal of content already submitted.

- `disabled` / `unconfigured`: check the saved enable flag, model, HTTPS base,
  API format, timeout/input limits and whether a key is configured.
- `AI_SETTINGS_KEY_UNAVAILABLE`: initialize the environment encryption Secret;
  if it changed, replace the provider key. No plaintext key is returned.
- `AI_KEY_REENTRY_REQUIRED`: re-enter the key after changing the base URL.
- `AI_PROVIDER_AUTH` / `AI_PROVIDER_FORBIDDEN`: check API key authentication,
  project access, IP allowlists and supported regions.
- `AI_PROVIDER_MODEL_NOT_FOUND`: the model ID is missing or the project cannot
  access it. `AI_PROVIDER_NOT_FOUND`: check the API URL and selected format.
- `AI_PROVIDER_BAD_REQUEST`: check model support for the API and structured output.
- `AI_PROVIDER_QUOTA`: check OpenAI Platform credits and project/organization
  limits. This is distinct from `AI_RATE_LIMITED` and is never retried automatically.
- `AI_OUTPUT_LIMIT` / `AI_REFUSED`: no analysis is saved; shorten the input or
  choose a suitable model instead of automatically resubmitting it.
- `AI_BUSY` / `processing`: refresh after a minute. Worker interruption cannot
  leave a permanent processing lock.
- `AI_QUOTA_EXCEEDED` / `AI_RATE_LIMITED`: wait for the application/provider quota.
- `AI_TIMEOUT` / `AI_PROVIDER_UNAVAILABLE`: retry later and verify connectivity.
- `AI_INVALID_RESPONSE`: the model must return plain JSON with the documented
  fields and finish normally; schema, enum, size or date-evidence violations fail
  safely. No provider response body is returned to the client.
- `AI_BODY_EMPTY` / `AI_BODY_UNAVAILABLE`: check the owned canonical D1/R2 body;
  attachment-only messages are not analyzed.
- `AI_CACHE_INVALID`: explicitly regenerate after cooldown.
- `AI_AUTHORIZATION_CHANGED`: background processing consent was revoked before
  provider submission; no AI request is started and normal notification policy applies.
- `AI_SETTINGS_CHANGED`: settings were disabled or the effective language/model/input
  configuration changed during generation; reload and explicitly retry. The old
  result is not returned or cached. This cannot recall an already submitted request.

禁用：在「设置 → AI 设置」关闭并保存，原有邮箱行为继续。
禁用不删除已缓存结果，也不能撤回已发送至供应商的内容。配置错误时核对启用开关、
HTTPS 地址、模型、参数范围及 Secret 是否存在，勿输出密钥。繁忙时一分钟后刷新；
超时或供应商故障可稍后重试；认证错误私下检查权限；限流等待配额恢复；响应校验失败
检查模型是否遵循 JSON 契约；空正文或正文不可用时检查本地正文/R2 完整性。

## Acceptance without real email / 无真实邮件验收

`bun test src/lib/server/ai` uses deterministic injectable fake providers and
in-memory SQLite, without external requests or real tokens. Browser tests in
`tests/e2e/mail-ai.spec.ts` and `mail-ai-settings.spec.ts` use synthetic local mailbox data and mocked AI HTTP
responses; they prove UI behavior, not a real MaaS integration. For later manual
provider acceptance, use an explicitly authorized synthetic non-sensitive email,
verify Chinese and English, cached reload, regeneration, invalid credential,
rate-limit and timeout behavior, and check provider billing separately. No real
MaaS consumption or real-mail analysis is required by this task.

本地测试使用可注入 Fake Provider，浏览器使用合成邮件和模拟 AI 响应，不调用真实 MaaS。
后续真实供应商验收应先取得授权，仅用无敏感信息的合成邮件验证中英文、缓存、重新生成、
认证错误、限流及超时，再单独核对供应商计费；不得把本地验证当作真实供应商验证。
