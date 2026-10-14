# 列表分页与设置标签页分析

状态：文档阶段的历史源码核查与需求确认。以下现状和测试结果对应核查基线；后续功能实现与验收见目标 Spec。

核查日期：2026-10-14。基线：`main@0961661b1bfb4a9ed2dc8ca2696dc80ed391988c`，已与 `origin/main` 及远端 main 核对一致。

文档工作树：`/tmp/FlareMail-list-pagination-settings-spec`；分支：`docs/list-pagination-settings-spec`。主工作树保持原状。

[目标 Spec](../specs/list-pagination-and-settings-tabs.md) · [文档索引](../README.md)

## 结论与现状

三项需求均有明确的改进对象。列表需要区分已有分页、交互不一致和无法继续读取三种情况；设置页的重复语言入口和锚点导航则由组件源码直接确认。

| 对象 | 当前行为与源码依据 | 需要调整的内容 |
| --- | --- | --- |
| 邮件列表 | [查询契约](../../src/lib/server/workspace/mailbox-query.ts)默认每页 40 封、最大 100 封，已有 `cursor`；[列表](../../src/lib/components/mail/MessageList.svelte)展示“加载更多”，[控制器](../../src/lib/client/mailbox-controller.ts)将新页合并进已加载集合 | 将累积展示改成当前页展示，并提供上一页、下一页与页码 |
| 邮件会话 | [会话聚合](../../src/lib/domain/mail/thread.ts)在客户端将邮件合并为会话行；服务端分页单位仍是单封邮件 | 明确每页 40 封是记录上限，会话行可少于 40 行，同一会话可跨页出现 |
| 域名和邮箱地址 | [资源页面](../../src/lib/components/mail/MailIdentityManager.svelte)已有每页 25 条分页；`currentPage.pageCount > 1` 时才显示按钮；[列表辅助模块](../../src/lib/client/mail-resource-list.ts)先筛选、排序，再分页 | 复用现有分页逻辑，统一控件、边界状态及单页可发现性 |
| 回收站 | [客户端](../../src/lib/client/workspace-api.ts)固定请求 `limit=500`；[GET 接口](../../src/routes/api/workspace/trash/+server.ts)只接收 limit；[查询](../../src/lib/server/workspace/trash.ts)合并三类来源后截断并返回 `hasMore`，没有后续游标 | 补齐游标查询和前端翻页，避免超过 500 条后无法访问其余记录 |
| 回收站“加载更多” | [页面](../../src/routes/+page.svelte)向回收站列表传入 `loadMoreMailbox`，但该函数遇到 `activeSection === 'trash'` 直接返回 | 替换失效链路；增加超过上限的行为测试 |
| Telegram 历史 | [状态查询](../../src/lib/server/telegram/workspace.ts)固定读取最近 10 条；[设置组件](../../src/lib/components/mail/TelegramNotificationPanel.svelte)直接展示 `recentDeliveries`；[历史接口](../../src/routes/api/workspace/notifications/telegram/deliveries/+server.ts)虽支持 limit，仍无 cursor 或 `hasMore` | 设置状态与历史列表分开加载，通过历史接口分页 |
| 设置语言入口 | [设置组件](../../src/lib/components/mail/ProfilePane.svelte)标题旁再次渲染 `LanguageSwitcher`；[桌面全局偏好](../../src/lib/components/shell/AppTopbar.svelte)和[手机导航](../../src/lib/components/shell/MobileNavigation.svelte)已有语言入口 | 删除设置页标题旁的重复入口，验证全局入口仍可达 |
| 设置导航 | [设置组件](../../src/lib/components/mail/ProfilePane.svelte)使用 `href="#settings-…"` 跳到对应 Panel；所有设置内容同时渲染 | 改为五个真正的标签面板，当前面板之外的内容不参与可见布局和键盘焦点 |
| 设置保存 | 当前一个 form 提交完整 `nextProfile`；成功后整体替换草稿。外观即时生效，Telegram 有自己的操作接口 | 个人资料、通知分别保存，不能提交或覆盖另一标签的未保存输入 |

域名和地址分页属于完整集合的客户端分页，仍会通过身份 GET 接口读取全部配置。本需求确定了展示分页，不据此宣称网络传输量或大规模查询性能已优化。

## 已确认的需求选择

| 决策 | 用户确认结果 |
| --- | --- |
| 分页覆盖 | 独立数据列表：所有邮件视图及搜索、域名、邮箱地址、回收站、Telegram 历史 |
| 详情集合 | 附件、会话内邮件和投递时间线沿用现有展示；侧栏导航和下拉候选项沿用现有展示 |
| 分页方式 | 上一页、下一页、当前页；有对应查询准确总数时显示总页数 |
| 邮件分页单位 | 沿用邮件记录页，每页最多 40 封；继续复用现有邮件接口 |
| 设置分组 | 个人资料、通知、外观、诊断、Telegram 五项 |
| 保存范围 | 只保存当前标签；切换标签保留未保存输入；外观和 Telegram 延续现有生效方式 |
| 批量范围（实现阶段补充确认） | 保留显式会话扩展；默认仅当前页，翻页清空选择并恢复默认范围 |

Spec 的默认页大小为邮件 40 封、域名和地址 25 条、回收站 40 条、Telegram 20 条。此次不增加任意页跳转或每页条数选择器。

## 实现时需要处理的边界

### 分页数据与页面状态

邮件的现有游标绑定文件夹、分类、搜索、状态及身份范围，不能跨查询复用。改成按页展示后，缓存和上一页历史也必须按查询隔离；当前渲染集合不能继续累积追加。现有 [导航与已读 Spec](../specs/mailbox-navigation-and-read-state.md)中的会话内存、认证隔离、迟到响应防护和状态修补仍需保留。

总数必须来自同一查询。Owner 的全局统计、导航徽标和会话行数不能代替搜索或身份筛选后的邮件记录总数；没有准确总数时只显示当前页。分页后的批量选择也不能隐含覆盖其他页。

回收站来自工作区邮件、草稿、入站状态三种来源，游标必须对应合并后的统一顺序。在各来源应用同一位置边界后再合并截断，不能分别分页后简单拼接。公开 ID 的入站前缀也必须参与统一比较。[清空回收站](../../src/lib/server/workspace/trash.ts)现有 500 条保护是独立写入边界，展示分页不改变其语义。

资源列表继续使用完整集合计算状态、地址计数、筛选及发件选项，避免将当前 25 条切片用于全局能力判断。删除、恢复或刷新导致结果缩减时，必须重新建立可访问的页码和游标；失败保留旧内容，不显示虚假的末页成功状态。

### 标签、保存与异步生命周期

个人资料与通知共用 [UserProfile 类型](../../src/lib/domain/mail/types.ts)及[完整资料 PUT 接口](../../src/routes/api/workspace/profile/+server.ts)。独立保存可由客户端合成完整提交：以最新服务端资料为基底，仅覆盖当前标签的字段。成功后按字段合并，保留另一标签的草稿；不能继续整体用响应替换 `nextProfile`。[现有草稿合并模块](../../src/lib/client/profile-draft.ts)提供了保留本地改动、吸收未编辑字段更新的基础。

非当前标签的表单字段不能阻塞当前标签的浏览器校验；错误应留在所属标签。外观和 Telegram 不显示资料保存按钮。显示邮箱及签名仍是现有资料功能，自动回复仍是运行配置说明，不能因重新分组变成新的配置能力。

Telegram 目前在组件挂载时读取状态、注册窗口事件并维护绑定轮询。简单卸载隐藏标签会丢失绑定链接；保持组件挂载却不通知它已隐藏，则会继续轮询或把焦点移入隐藏面板。目标应采用首次激活后保留实例、隐藏时暂停读取与焦点跳转的生命周期。

标签状态需进入 URL，兼容已有 `#settings-*` 深链，并保留域名、地址管理使用的 `view` 与 `domain` 参数。标签切换不再滚动到长页锚点。

## 验证记录与后续门禁

规划阶段已在同一核查基线上使用 Bun 1.4.3 执行以下现有测试：

```bash
bun test \
  src/lib/client/mail-resource-list.test.ts \
  src/lib/client/mailbox-controller.test.ts \
  src/lib/client/trash-controller.test.ts \
  src/lib/client/workspace-url-controller.test.ts \
  src/lib/client/profile-draft.test.ts \
  src/lib/server/workspace/mailbox-query.test.ts \
  src/routes/api/workspace/trash/trash.test.ts
```

结果：52 pass、0 fail、179 次断言。覆盖现有筛选分页、邮件游标与缓存、URL 状态、草稿合并、回收站读取和取消，以及基本回收站接口操作。现有测试没有证明超过 500 条的回收站可继续读取，也没有覆盖目标标签页或独立保存。

本次文档交付只检查差异、文档命令存在性和相对链接，不重复运行不受文档影响的代码门禁。未进行浏览器验收、CI、PRE、生产部署、远程迁移或真实邮件/Telegram 操作。后续功能验收以 [目标 Spec 的验收矩阵](../specs/list-pagination-and-settings-tabs.md#验收矩阵)为准。

## 文档关系与后续交付

本分析保留规划阶段的基线现状；功能实现状态和新增验收以 Spec 的后续记录为准。已有[资源管理 Spec](../specs/mail-resource-management.md)、[导航与已读 Spec](../specs/mailbox-navigation-and-read-state.md)及[UI/UX 记录](../UI_UE_REVIEW.md)包含历史实现和验收，应保留原来的基线与证据。

功能实现后同步 [用户指南](../USER_GUIDE.md)、[API 契约](../API.md)、[Telegram 指南](../TELEGRAM.md)及对应设计说明，并记录新的提交与验证结果。按 [worktree 与 PR 流程](../DEVELOPMENT.md#worktree-and-pr-workflow)在隔离工作树开发、验证和提交；PRE、push/PR、合并及生产发布分别按授权执行。
