# AI 摘要语言与 Telegram 自动摘要 SPEC

状态：本地已实现，PRE 迁移及业务验收待授权；基线 `8457cd9b0c94819f7b1c2ada582c070a5bb2bb13`。

## 目标与现状

1. 邮件摘要默认跟随界面语言，也能独立指定语言，网页和 Telegram 共用解析规则与缓存。
2. Telegram 新邮件通知在用户单独同意后自动生成 AI 摘要；模型异常不阻断原有通知。

当前网页 AI 仅按需调用，语言来自请求中的 `zh-CN` / `en`。语言已经参与缓存
fingerprint。界面语言仅保存在浏览器 Cookie/localStorage，不存在服务端用户语言字段。
Telegram 的 `summaryEnabled` 只控制原文 snippet；投递表保存入队时的隐私/摘要快照，
发送前再次收紧权限。不得把已有短摘要开关视为向外部 AI 发送正文的授权。

## 语言行为与数据契约

- Owner 的 `mailAi` 设置 JSON 新增 `summaryLanguage`，取值 `auto` 或规范化 BCP 47
  语言标签（例如 `en`、`zh-CN`、`zh-TW`、`ja`）；`backgroundLanguage` 保存本次设置
  提交时的有效界面语言，只接受 `zh-CN` / `en`。旧设置缺字段分别默认为 `auto` / `zh-CN`。
- 网页有效语言：自定义 `summaryLanguage` 优先，否则使用当前请求的界面语言。
  既有 API 的 `language` 仍表示界面上下文，不能覆盖 Owner 已保存的自定义偏好。
- Telegram 有效语言：自定义值优先，否则使用 `backgroundLanguage`。后台没有浏览器
  上下文；修改界面语言后需重新保存 AI 设置才会更新后台自动语言，界面明确说明。
- 自定义语言只接受最多 64 字符的有效语言标签，使用平台语言标签校验并规范化；
  拒绝空值、控制字符、无效标签和自由 Prompt。不扩展全站界面翻译语言。
- 模型输出 `language` 必须等于解析后的标签。两种 provider 格式与官方严格 schema
  同步支持该标签；Prompt 以“输出语言”表达，升级 `MAIL_AI_VERSION` 使旧缓存安全失效。
- 最终有效语言参与缓存；固定语言时切换界面语言不改变有效缓存，自动模式下改变语言
  后只读新缓存，不自动发起模型调用。网页仍须点击授权生成。
- 保持密钥加密、地址校验、revision 并发控制以及旧客户端缺字段保存兼容。

## Telegram 行为与安全边界

- Telegram binding 新增 `aiSummaryEnabled`，默认关闭；独立开关明确说明自动发送有限
  邮件正文到已有 AI 服务、可能计费、共用 30 次/Owner/小时额度。保存开关不调用模型。
- 入队时保存 AI 同意快照。只有全局通知可用、绑定有效且开启、入队和当前均授权 AI、
  入队和当前均允许摘要且均非隐私模式、邮件仍属于该 Owner 且可见时，才允许处理。
  事后开启不得为既有队列追溯扩大授权；关闭需对待发通知立即生效。
- AI 在 outbox dispatcher 执行，复用 `workspaceMailAi` 的正文加载、归属校验、
  黑名单/隔离限制、输入裁剪、provider、结果校验、缓存、租约、冷却和额度。
  收信持久化不等待 AI；快速推送预算不足时保留任务交由定时 dispatcher。
- 每个 delivery 在首次生成前原子记录 AI 已尝试。AI 与 Telegram 的
  `external_started` 分开：后者仅代表真正准备向 Telegram 发请求。
  Telegram 重试可读命中缓存，但不得再次为同一 delivery 生成；即使 AI 超时或进程
  中断，也不自动再次计费。网页用户仍可按现有规则手动生成。
- AI 超时受剩余 dispatcher 预算和投递租约约束，预留 Telegram 请求时间；预算不足
  不开始模型调用。AI 错误、禁用、未配置、正文为空、超额、缓存不可用均退回原 snippet。
  不为 AI 故障单独重试通知，不自动应用分类、不额外发第二条 Telegram 消息。
- 成功仅使用已验证 `analysis.summary`，标记为“AI 摘要”，按现有 300 字符摘要限制
  清洗/截断，整条消息继续遵守既有长度限制，以纯文本发送，禁用网页预览。
- AI 完成后、Telegram 外部发送前复核绑定/消息/隐私/摘要/AI权限；撤销时丢弃 AI
  内容或取消投递。隐私模式不生成也不展示正文摘要。不记录正文、Token 或供应商原文。
- 模型完成后若有效语言、模型、地址、格式、输入上限或启用状态变化，返回
  `AI_SETTINGS_CHANGED`，释放 claim 且不返回/缓存旧结果；已外发内容无法撤回。
- 新增顺序迁移，旧 binding/delivery 的 AI 授权默认 false，尝试标记默认 false；
  同步 schema 快照、版本和迁移测试。远程迁移必须单独获得授权。
- 共享数据库升级前，先发布仅放宽 schema 30/31 校验、保持旧 Telegram 实现的兼容
  桥接代码。完整功能代码在 schema 30 上会停止 Telegram 入队，不能拿它作为不中断
  通知的桥接版本。桥接发布、远程迁移与后续生产功能发布均需各自明确授权。

## 界面与兼容

AI 设置添加「摘要语言」：跟随界面（默认）、简体中文、English、自定义语言代码。
保存后回读规范标签；说明后台自动模式的快照语义。Telegram 设置添加独立自动 AI
摘要开关，在隐私模式或短摘要关闭时禁用操作并解释依赖；保留已存开关，不借禁用控件
自动扩大权限。所有文案提供中英文，复用现有控件并覆盖键盘、触屏与窄屏布局。

不新增 AI 服务、SDK、队列基础设施或云资源；不做历史邮件批量分析、任意 Prompt、
邮件翻译、附件分析、自动分类写入或历史 Telegram 补发。

## Subagent 实施拆分

| 执行方 | 范围 | 交付与依赖 |
| --- | --- | --- |
| AI 核心 subagent | domain/ai、AI settings/provider/workspace 与相邻测试 | 先落实语言契约；提供后台复用入口与超时预算能力；不改 UI/Telegram 表 |
| Telegram subagent | binding/outbox DB、迁移、API、dispatcher、消息格式与测试 | 使用 AI 核心入口；独立授权快照、单次尝试、发送前复核、失败降级 |
| UI subagent | AI/Telegram 设置、摘要面板、client、i18n、browser tests | 消费前两者公开契约；语言保存、独立同意、缓存展示与无障碍 |
| 主 agent | SPEC、操作/API/双语文档、集成验证、本地 review、Git 流程 | 整合契约与反馈；所有共享生成产物相关验证串行 |

## 验收矩阵

| 范围 | 必须证明 |
| --- | --- |
| 设置 | 旧 JSON/客户端兼容、规范化标签、非法类型/标签拒绝、默认与自定义回读、密钥不回显、revision 冲突 |
| AI | auto 中文/英文、自定义语言优先、两种格式 schema、错误 language 拒绝、有效语言缓存失效/复用、权限重核 |
| Telegram | 明确 opt-in、旧队列不扩权、隐私/短摘要/全局开关、AI 成功与失败降级、撤销授权、限额/空正文、重试不重复生成 |
| 时序 | AI 不设置 Telegram external_started、预算不足延后、租约恢复与一次生成、发送状态未知仍沿用既有保守行为 |
| 迁移 | 空库、legacy fixture、schema 快照一致，旧数据 AI 默认关闭 |
| 浏览器 | Chromium 桌面/手机/320px、WebKit/Firefox、键盘、无横向溢出、axe、无相关 console 错误、截图 |
| 本地门禁 | `bun run test`、`bun run check`、`bun run build`、`bun run deploy:dry-run`、完整差异的 `codex review --base origin/main` |
| PRE | 对已提交 SHA 验收相关设置页、只读缓存 API、认证 readiness/绑定，记录 URL/版本；不使用真实邮件作 fixture |

用户已选择沿用现有 AI 配置并先做 fake/local 验证，随后提出可使用已有 PRE。
已核对用户提供的 `mail-ai` 原生 PRE：现有 D1 与实际生产部署不同，R2 相同。保留
实际绑定，不创建替代资源。PRE 独立 D1 迁移不会升级生产 D1；共享 R2 仍不得作
fixture 写入。发布、远程迁移、设置写入、真实邮件外发与真实 Telegram 投递分别
遵循仓库授权边界，不能用本地通过或健康检查代替相应证据。PRE 未满足时保留本地
提交和 worktree，不提前创建功能 PR。实施后以验收记录补充准确 SHA 与未覆盖项。

本地与环境核对证据见[验收记录](../verification/ai-language-and-telegram-summary.md)。
