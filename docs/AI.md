# Optional AI mail assistance / 可选 AI 邮件辅助

AI is **off by default**. This is an on-demand single-message summary and category
suggestion, not an agent. Nothing is sent to MaaS on receipt or merely opening a
message. The inbox rules, sending and receiving remain independent of AI.

AI **默认关闭**。仅按需生成单封邮件摘要和分类建议，不自动分析新邮件，不参与收发信事务。

## Enable / 启用

1. Follow the existing [Preview](PREVIEW.md) and [production checklist](PRODUCTION_CHECKLIST.md)
   before publishing. Migration `0030_mail_ai_analyses.sql` adds the cache, quota
   and deletion triggers; schema version becomes 30. Run all migrations locally
   with `bun run db:migrate:local`. Remote migration and deployment require their
   own authorization; this guide does not execute them.
2. Add these **string variables** to `vars` in the appropriate ignored private
   Cloudflare JSON target. Choose your trusted provider's public HTTPS endpoint:

   ```json
   {
     "AI_ENABLED": "true",
     "AI_PROVIDER": "openai-compatible",
     "AI_BASE_URL": "https://api.your-provider.com/v1",
     "AI_MODEL": "your-model-id",
     "AI_TIMEOUT_MS": "15000",
     "AI_MAX_INPUT_CHARS": "16000"
   }
   ```

   `AI_BASE_URL` must be the API base, excluding `/chat/completions`. Credentials,
   query strings, fragments, IP literals, local names and nonstandard ports are
   rejected; redirects are never followed. Only an administrator can choose the
   endpoint. Use a provider you trust with email contents and check its retention
   policy. Domain validation cannot prevent an administrator-controlled hostname
   from resolving to an inappropriate destination; keep DNS under trusted control.
3. Add `AI_API_KEY` to the target's `secrets` list, preserving existing names.
   Store its value as the Worker Secret **AI_API_KEY** in the corresponding
   Cloudflare Worker/Preview settings. Never put the value in `vars`, D1,
   frontend files, shell arguments or Git. Use permissions `0600` for any ignored
   local secret file. Native cf does not automatically load old `.dev.vars` files.
4. Publish only through the existing authorized release workflow. The remote
   Preview shares production data: use read-only acceptance unless writes and
   external processing have separate authorization.

中文步骤：先按现有发布流程验证本地 migration 0030（schema 30），再在对应私有 JSON
配置的 `vars` 中加入上述字符串配置；`AI_BASE_URL` 不含 `/chat/completions`，模型名
使用供应商实际支持的名称。将 `AI_API_KEY` 名称追加到 `secrets` 列表，并在对应 Worker
或 Preview 的 Secret 设置中安全保存值，不写入公开配置、命令参数、D1 或 Git。
配置完成后按已授权的 Preview/生产流程发布；本指南本身不授权发布或远程迁移。

## Use / 使用

Open an owned inbox message (workspace, reader dialog or standalone reader),
expand **AI summary and category suggestion**, then select **Agree and generate
analysis** after reading the external-processing notice. Expanding reads only the
cache. Summary and category views share one result and do not consume extra tokens
when switching views. Refreshing the page preserves D1 results. **Agree and
regenerate** requests a new analysis. Interface language (`zh-CN` or `en`), model,
endpoint, prompt/schema version and full body changes invalidate the cache.

The category view shows the current category, explanation and uncalibrated model
self-assessment. **Confirm and apply category** uses the existing inbox category
API and the current identity/category scope. Suggestions never apply themselves.
A visible manual category is preserved; return to automatic classification through
the existing inbox controls before applying a suggestion. Archived mail retains
its cached result; return it to the inbox to apply a category.

在邮件详情展开「AI 摘要与分类建议」，阅读隐私提示后点击「同意并生成分析」。
展开面板只读缓存，摘要和分类视图共用一次分析；刷新页面保留结果。「同意重新生成」
会请求新的分析。界面语言、模型、服务端地址、Prompt/Schema 或完整正文变化都会使缓存失效。
分类建议不会自动生效；点击「确认应用此分类」才调用现有分类接口，并保留当前筛选范围。
已有手动分类时禁止应用建议；可先通过原有收件箱操作恢复自动分类。归档和回收站保留缓存，
永久删除邮件会同步清理分析结果。

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
60-second recoverable claim lease; each Owner has 30 attempts/hour. Only an
explicit `429` with `Retry-After: 0` is retried once. Network errors, timeouts and
5xx responses are not automatically retried because they may already be billed.

仅发送必要主题、发件人及有限长度的纯文本，不发送附件、原始邮件、技术 Headers、
收件人列表或认证信息。长邮件有覆盖范围提示。日期必须直接出现在正文中，但其他摘要内容仍可能
被模型误解，请以原文为准。默认超时 15 秒、正文最多 16000 字符、输出最多 1800 Token、
响应最多 32 KiB。每封邮件冷却 30 秒，租约 60 秒可恢复；每 Owner 每小时最多 30 次尝试。
隔离和黑名单邮件禁用 AI，草稿与已发送邮件暂不支持。

## Disable and troubleshoot / 禁用与排错

Set `AI_ENABLED` to `"false"` and publish through the authorized workflow to stop
all new provider calls; normal email rules continue. Saved analyses stay in D1
until their message is permanently deleted. Disablement is not provider-side
removal of content already submitted.

- `disabled` / `unconfigured`: check enable flag, provider, model, HTTPS base,
  timeout/input limits and the **presence**, never the displayed value, of Secret.
- `AI_PROVIDER_AUTH`: verify provider credential access privately; do not paste it
  into logs or issue reports.
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

禁用：将 `AI_ENABLED` 改为 `"false"` 并按授权流程发布，原有邮箱行为继续。
禁用不删除已缓存结果，也不能撤回已发送至供应商的内容。配置错误时核对启用开关、
HTTPS 地址、模型、参数范围及 Secret 是否存在，勿输出密钥。繁忙时一分钟后刷新；
超时或供应商故障可稍后重试；认证错误私下检查权限；限流等待配额恢复；响应校验失败
检查模型是否遵循 JSON 契约；空正文或正文不可用时检查本地正文/R2 完整性。

## Acceptance without real email / 无真实邮件验收

`bun test src/lib/server/ai` uses deterministic injectable fake providers and
in-memory SQLite, without external requests or real tokens. Browser tests in
`tests/e2e/mail-ai.spec.ts` use synthetic local mailbox data and mocked AI HTTP
responses; they prove UI behavior, not a real MaaS integration. For later manual
provider acceptance, use an explicitly authorized synthetic non-sensitive email,
verify Chinese and English, cached reload, regeneration, invalid credential,
rate-limit and timeout behavior, and check provider billing separately. No real
MaaS consumption or real-mail analysis is required by this task.

本地测试使用可注入 Fake Provider，浏览器使用合成邮件和模拟 AI 响应，不调用真实 MaaS。
后续真实供应商验收应先取得授权，仅用无敏感信息的合成邮件验证中英文、缓存、重新生成、
认证错误、限流及超时，再单独核对供应商计费；不得把本地验证当作真实供应商验证。
