# FlareMail 设计系统

> 状态：FlareMail 重构的权威设计规范
>
> 调研基线日期：2026-08-13
>
> 产品：FlareMail——部署在 Cloudflare Workers 上的邮件工作台
>
> 视觉参考：当前 Cloudflare Dashboard 的产品设计语言；只做适配与借鉴，不做复制

## 1. 文档目的

本文件定义 FlareMail 的视觉系统、交互模型、响应式行为、可访问性基线和组件规则。

目标是形成一个成熟、任务导向、信息密度适中且可长期维护的产品界面，并体现现代 Cloudflare Dashboard 的关键特征：

- 导航与当前上下文清楚；
- 紧凑但不拥挤；
- 主要用背景、边框和间距建立层级；
- 组件和状态语义一致；
- 键盘与屏幕阅读器操作完整；
- 浅色、深色和跟随系统主题完整；
- 桌面、平板、手机上的邮件工作流都可用。

FlareMail 必须保持独立产品身份。不得复制 Cloudflare 源代码、专有字体、图标、Logo、插画或完整页面构图；不得让用户误认为 FlareMail 是 Cloudflare 官方产品。Cloudflare 只作为产品设计参考。

## 2. 设计原则

### 2.1 任务导向导航

导航按用户要完成的任务组织，不按底层实现和供应商名称组织。

主导航：

- 收件箱
- 已发送
- 草稿箱
- 设置

Cloudflare Email Routing、D1、R2、Resend 等技术信息应放在状态详情、诊断或设置页面中，不应成为主信息架构。

### 2.2 紧凑，但不局促

使用后台产品的紧凑节奏，而不是营销站或杂志排版。

- 常规应用文本使用 14 px。
- 元数据和次级标签使用 12 px。
- 邮件列表行高约 64–76 px。
- 用间距分组，但不要把每个区域都包成大卡片。
- 禁止超大标题、空旷 Hero 区和编辑杂志式布局。

### 2.3 先边框，后阴影

默认层级按以下顺序建立：

1. 背景差异；
2. 1 px 边框；
3. 间距；
4. 字体层级；
5. 状态色。

阴影只用于 Dialog、Popover、Menu 等真正悬浮的覆盖层。普通页面区域不得依赖阴影分隔。

### 2.4 语义色，而非装饰色

颜色用于表达状态和操作。

- 蓝色：主要交互、CTA、链接、焦点。
- 橙色：FlareMail 品牌强调、活动提示或选中强调。
- 绿色：成功、已送达。
- 琥珀色：警告、延迟、排队。
- 红色：破坏操作、错误、退信、发送失败。
- 中性灰：结构和默认非激活状态。

亮橙色与白色正文对比不足，不得使用“亮橙底 + 白色小字”。亮橙底使用深色文字；需要白字时使用更深的橙色 token。

### 2.5 通过基础组件保持一致

Button、Field、Tabs、Badge、Menu、Table、Dialog、Banner 等必须由共享 UI primitives 实现，不允许在不同邮件组件里分别手写同类控件。

### 2.6 可访问性是发布条件

目标为 WCAG 2.1 AA。

以下核心流程必须可用键盘和屏幕阅读器完成：

- 登录；
- 文件夹导航；
- 邮件列表导航；
- 打开邮件；
- 已读/未读与星标；
- 写信、回复、转发、保存草稿、发送、关闭；
- 编辑资料和设置；
- 重试失败投递；
- 下载附件或原始邮件。

## 3. 品牌和素材规则

- 产品名：`FlareMail`。
- 使用自定义 FlareMail 字标或本地绘制的 `FM` / 火焰信封标记。
- 禁止使用 Cloudflare Logo、云形标记、专有字体、专有图标或复制的插画。
- 禁止把 “Cloudflare” 放入 FlareMail 产品名称。
- 可以事实性展示“Powered by Cloudflare Workers”或“运行于 Cloudflare Workers”。
- 可以用纯文本 Badge 展示 `Cloudflare Email Routing`、`D1`、`R2`、`Resend`，但这些供应商标识不得压过 FlareMail 自身品牌。

## 4. 信息架构

### 4.1 桌面应用壳层

视口宽度 `>= 1280px`：

- 全局顶部栏：48–52 px。
- 主侧边栏：224–248 px。
- 邮件列表栏：360–420 px；如实现拖拽调整，应限制在合理范围。
- 邮件详情栏：占据剩余空间，实用最小宽度约 520 px。
- 应用占满视口，但各栏独立滚动。不得通过全局 `overflow: hidden` 破坏手机、缩放或小窗口滚动。

推荐层级：

```text
应用壳层
├── 全局顶部栏
│   ├── FlareMail 标识
│   ├── 工作区/账号上下文
│   ├── 全局搜索或命令入口
│   ├── 服务状态
│   └── 主题/个人菜单
├── 侧边栏
│   ├── 写邮件
│   ├── 邮件
│   │   ├── 收件箱
│   │   ├── 已发送
│   │   └── 草稿箱
│   └── 设置
└── 主工作区
    ├── 文件夹标题与筛选
    ├── 邮件/线程列表
    └── 邮件详情
```

### 4.2 平板

视口宽度 `768–1279px`：

- 侧边栏折叠为窄图标栏，或使用 Drawer。
- 邮件列表和详情采用两级流程。
- 打开邮件时可以替换列表，但必须提供明显的返回操作。
- 写信使用大尺寸 Dialog 或右侧 Sheet。

### 4.3 手机

视口宽度 `< 768px`：

- 同一时刻只展示一个主工作面板。
- 使用紧凑 App Bar，包含文件夹标题、导航入口、搜索和溢出操作。
- 邮件详情采用可返回的 drill-in 页面。
- 写信使用全屏或近全屏界面。
- 触控目标至少 44 × 44 CSS px。
- 禁止页面横向滚动。
- 必要操作不能只依赖 hover 才显示。

## 5. 布局与间距 Token

使用 4 px 基础网格。

```css
--space-0: 0;
--space-1: 0.25rem;  /* 4 */
--space-2: 0.5rem;   /* 8 */
--space-3: 0.75rem;  /* 12 */
--space-4: 1rem;     /* 16 */
--space-5: 1.25rem;  /* 20 */
--space-6: 1.5rem;   /* 24 */
--space-8: 2rem;     /* 32 */
--space-10: 2.5rem;  /* 40 */
```

推荐控件高度：

- compact button/input：28–30 px；
- default button/input：32–36 px；
- prominent action：36–40 px；
- 手机控件：实际触控区域至少 44 px。

圆角：

```css
--radius-sm: 4px;
--radius-md: 6px;
--radius-lg: 8px;
--radius-xl: 12px; /* 只用于 Dialog 和大型覆盖层 */
--radius-pill: 999px;
```

禁止把所有容器做成胶囊或大圆角。

## 6. 色彩系统

以下是受 Cloudflare Dashboard 行为启发的 FlareMail 语义 token，不声称是 Cloudflare 内部 token。

### 6.1 浅色主题

```css
--fm-canvas: #f7f7f8;
--fm-surface: #ffffff;
--fm-surface-subtle: #f1f3f5;
--fm-surface-hover: #eceff3;
--fm-surface-selected: #eaf2ff;

--fm-border: #d9dde3;
--fm-border-strong: #b7bec8;

--fm-text: #1d1d1f;
--fm-text-secondary: #4f5965;
--fm-text-muted: #687483;
--fm-text-inverse: #ffffff;

--fm-primary: #0055dc;
--fm-primary-hover: #003ea8;
--fm-primary-soft: #e5efff;

--fm-brand-orange: #f48120;
--fm-brand-orange-strong: #b54300;
--fm-brand-orange-soft: #fff0e2;

--fm-success: #0b7a53;
--fm-success-soft: #e5f5ee;
--fm-warning: #a15c00;
--fm-warning-soft: #fff2d9;
--fm-danger: #b42318;
--fm-danger-soft: #fdecea;
--fm-info: #0055dc;
--fm-info-soft: #e5efff;

--fm-focus: #0a65cc;
--fm-overlay: rgb(15 23 42 / 0.40);
```

### 6.2 深色主题

```css
--fm-canvas: #1d1d1d;
--fm-surface: #252525;
--fm-surface-subtle: #2d2d2d;
--fm-surface-hover: #363636;
--fm-surface-selected: #17345f;

--fm-border: #444444;
--fm-border-strong: #5d5d5d;

--fm-text: #f4f4f5;
--fm-text-secondary: #d4d4d8;
--fm-text-muted: #a1a1aa;
--fm-text-inverse: #111827;

--fm-primary: #7ab5ff;
--fm-primary-hover: #a3c9ff;
--fm-primary-soft: #183a66;

--fm-brand-orange: #ff9a45;
--fm-brand-orange-strong: #f48120;
--fm-brand-orange-soft: #4a2a13;

--fm-success: #58c79b;
--fm-success-soft: #163d31;
--fm-warning: #f1b85b;
--fm-warning-soft: #493514;
--fm-danger: #ff8a80;
--fm-danger-soft: #4a2220;
--fm-info: #7ab5ff;
--fm-info-soft: #183a66;

--fm-focus: #8bc1ff;
--fm-overlay: rgb(0 0 0 / 0.64);
```

### 6.3 使用规则

- 浅色主按钮：蓝底白字。
- 深色主按钮：浅蓝底深色文字。
- 橙色用于 Logo、选中指示、细小状态强调或品牌点缀，不作为所有 CTA 的默认底色。
- 破坏性操作必须使用明确红色，并在可能丢失数据时提供确认机制。
- 状态不能只靠颜色表达，必须配图标、文字或两者。
- 所有文字/背景组合通过自动化对比度检查。

## 7. 字体排版

使用系统优先的无衬线字体，不使用 Cloudflare 专有字体。

```css
font-family:
  Inter,
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  sans-serif;
```

推荐字号：

- 页面标题：20–24 px，600；
- 分区标题：16–18 px，600；
- 常规 UI/正文：14 px，400；
- 列表重点标题：14 px，550–600；
- 元数据：12 px；
- 小 Badge：11–12 px，仅在必要时使用；
- 等宽字体只用于技术 ID、需要对齐的时间戳和诊断信息。

规则：

- 禁止衬线展示字体。
- 中文标签禁止使用大字距全大写风格。
- UI 行高约 1.4–1.6，邮件正文约 1.65–1.8。
- 列表元数据可谨慎截断，但打开邮件后的主题和关键错误必须可完整查看。

## 8. 图标

- 统一使用一套开源图标，优先 `lucide-svelte`，或实现少量本地图标组件。
- 默认 16 px；主导航 18–20 px。
- 描边宽度保持一致。
- 纯图标按钮必须有可访问名称和 Tooltip。
- 禁止复制 Cloudflare 专有图标。
- 禁止混用无关的填充、描边、Emoji 风格。

## 9. 核心 UI Primitives

在 `src/lib/components/ui/` 或等价目录创建共享基础组件。

必需组件：

- `Button`
  - primary、secondary、ghost、danger；
  - compact/default；
  - loading/disabled。
- `IconButton`
- `TextField`
- `TextArea`
- `Select`
- `Checkbox`
- `Switch`
- `Tabs`
- `Badge`
- `StatusBadge`
- `StatusDot`
- `Banner` / `Alert`
- `Card` / `Panel`，谨慎使用
- `Table` 或结构化数据列表
- `EmptyState`
- `Skeleton`
- `Dialog`
- `Drawer` / `Sheet`
- `DropdownMenu`
- `Tooltip`
- `Toast`
- `ConfirmDialog`
- `Pagination` 或 cursor loading
- `CommandPalette` 或快捷键帮助面板（如实现）

组件要求：

- variant 样式只有一个来源；
- 完整键盘支持；
- 可见 focus；
- 正确 disabled 语义；
- loading 时控件宽度不应突然变化；
- 异步成功/失败按需要使用 `aria-live`；
- feature 组件不得重复粘贴同类控件的大段 Tailwind class。

## 10. 应用组件

建议组件结构：

```text
src/lib/components/
├── ui/
├── shell/
│   ├── AppTopbar.svelte
│   ├── AppSidebar.svelte
│   ├── MobileNavigation.svelte
│   └── ServiceStatusMenu.svelte
└── mail/
    ├── FolderHeader.svelte
    ├── MailSearchBar.svelte
    ├── MailFilterBar.svelte
    ├── MessageList.svelte
    ├── MessageListItem.svelte
    ├── MessageDetail.svelte
    ├── MessageHeader.svelte
    ├── MessageBody.svelte
    ├── AttachmentList.svelte
    ├── DeliveryTimeline.svelte
    ├── ComposeDialog.svelte
    └── EmptyMailbox.svelte
```

名称可以调整，但职责必须拆分清楚。

## 11. 邮件工作区行为

### 11.1 文件夹标题区

每个文件夹视图应包含：

- 标题与数量；
- 搜索；
- 相关筛选；
- 刷新；
- 可选排序；
- 必要时显示简洁的服务/错误 Banner。

主标题栏不得长期铺满 D1、R2 等技术状态 Chip。详细 provider health 放入状态菜单或设置/诊断。

### 11.2 邮件/线程列表

每行展示：

- 未读状态；
- 发件人或收件人；
- 主题；
- 简短预览；
- 时间；
- 星标；
- 线程数量（大于 1 时）；
- 已发送邮件的投递状态。

规则：

- 整行可选中。
- 次级操作可用键盘访问，且不能误触发行选择。
- 选中状态使用浅蓝背景和窄橙色或蓝色指示条。
- 未读使用字重和标记，不只把文字变蓝。
- 桌面可在 hover 时显示次级操作，但触屏必须能发现和使用。
- 加载使用 Skeleton row。
- 完成空、首次、错误、分页结束状态。

### 11.3 邮件详情

Header：

- 主题；
- 发件人/收件人及地址详情；
- 时间；
- 回复、转发、星标、已读/未读、删除、原文下载、更多操作；
- 已发送邮件显示投递状态/时间线。

正文：

- plain text 是默认安全视图。
- 不可信 HTML 禁止直接插入应用 DOM。
- 如提供 HTML 视图，使用禁用脚本、默认阻止远程内容的 sandbox iframe。
- 保持空白和合适阅读行宽。
- 外链安全打开，使用 `noopener noreferrer`。
- 若支持远程图片，必须由用户显式加载。

附件：

- 文件名、类型、可读大小；
- 明确下载按钮；
- inline image 不默认信任；
- 完成 loading 和 failure 状态。

### 11.4 写信

桌面：

- 中大型 Dialog 或右侧 Sheet；
- 最大宽度约 760–900 px；
- 清楚的 To、Cc/Bcc、Subject、Body；
- sticky footer：保存草稿、自动保存状态、取消、发送。

手机：

- 全屏写信；
- sticky header/footer；
- 兼容 safe area。

行为：

- 用户短暂停止输入后自动保存；
- 显示未保存、保存中、已保存、失败；
- 关闭 dirty draft 时给出安全选择；
- Send 只在无效或提交中禁用；
- 校验靠近字段显示；
- 可提供带修饰键的发送快捷键，但必须明确且有文档；
- Modal 模式 trap focus，关闭后恢复触发按钮焦点。

### 11.5 邮件能力交互契约

地址与写信：

- To、CC、BCC 使用同一地址 chip 交互；显示名中的空格必须保留，逗号、分号、换行和粘贴多地址负责提交 chip。
- chip 必须支持键盘添加、移除、逐地址错误和去重；BCC 只在写信与明确允许的技术视图显示。
- 草稿附件同时属于内容和乐观并发状态。上传中、失败、重试、取消、删除与重命名都必须可见；关闭或刷新后不得伪装为已完成。
- Command Palette 尚未实现时，顶栏文案只能承诺搜索；实现后必须覆盖导航、写信、邮件动作、主题、刷新和诊断，并采用完整键盘与 ARIA combobox/dialog 语义。

阅读与附件：

- HTML reader 只消费服务端 allowlist 净化结果，并放入无 `allow-scripts`/`allow-same-origin` 的 sandbox iframe；纯文本始终是默认回退。
- 远程图片默认阻止，只允许单封、可撤销的 HTTPS 授权；CID 图片走当前邮件的 owner-scoped capability route，不依赖 iframe Cookie。
- 附件下载始终执行 ownership、size consistency、`no-store`、`nosniff` 和安全 disposition。未来预览必须按类型隔离；SVG、Office、压缩包与未知二进制不得内联执行。
- “下载全部”必须使用经验证的客户端或流式 ZIP 策略，不能把全部大附件一次读入 Worker 内存。

反馈与可恢复动作：

- Toast 使用 `info`、`success`、`warning`、`error` tone，支持 action、timeout、persistent、request ID 和 ARIA live；持久错误还必须在页面上下文提供恢复入口。
- 移入垃圾箱、恢复、归档和未来的标签/Snooze 操作应乐观更新并精确回滚；短期撤销不得替代服务端幂等与 ownership preflight。
- 标签只改变映射，不删除邮件；Snooze 只改变可见时间并必须跨重启持久，恢复动作需由 Queue/Cron 或等价可靠调度驱动。

### 11.6 投递时间线

已发送邮件提供紧凑、可展开的时间线：

- queued；
- submitted/accepted by Resend；
- sent；
- delivered；
- delayed；
- bounced；
- failed；
- complained；
- suppressed；
- 在开启 tracking 时显示 opened/clicked。

API 受理不能显示为“已送达”。在 webhook 确认之前使用“已提交至 Resend”等准确文案。

## 12. 登录与设置

### 12.1 登录

- 中性 canvas 上的简洁居中面板。
- FlareMail 标识、邮箱、密码、提交。
- 生产环境无硬编码 demo 凭据。
- 登录页不公开 D1/R2/secret 详细诊断。
- 用户看到通用认证错误，具体原因只进入安全日志。
- 正确设置 autocomplete，兼容密码管理器。

### 12.2 设置

按任务分区：

- 个人资料
- 发件身份
- 自动回复
- 通知
- 外观
- 诊断

供应商字段可以出现，但必须有清楚说明。

诊断不得泄露 secret 值，只显示已配置/缺失、最近成功的入站/外发事件和安全 ID。

## 13. 主题

- 支持 `light`、`dark`、`system`。
- 首次默认跟随系统。
- 持久化用户显式选择。
- system 模式下响应系统主题实时变化。
- 在首屏绘制前应用主题，避免闪烁。
- 所有 primitive 和状态都必须支持两个主题。
- 禁止简单反色实现深色模式。
- 深色 canvas 使用 off-black，而不是纯黑。

## 14. 交互与动效

- 常规过渡 120–180 ms。
- 只在帮助理解状态时使用 opacity、color 和轻微 transform。
- 禁止弹簧感、视差、玻璃拟态和装饰性页面转场。
- 尊重 `prefers-reduced-motion`。
- 列表动画不能导致选中项跳动。
- Toast 不能成为重要错误的唯一呈现位置。

## 15. 键盘行为

建议快捷键；在输入框/编辑器内默认禁用，除非明确设计：

- `/`：聚焦邮件搜索；
- `c`：写邮件；
- `g` 后 `i`：收件箱；
- `g` 后 `s`：已发送；
- `g` 后 `d`：草稿箱；
- `j` / `k`：下一条/上一条；
- `r`：回复当前邮件；
- `f`：转发当前邮件；
- `?`：快捷键帮助；
- `Escape`：关闭 Menu/Dialog，或按场景返回。

所有快捷键都有等价点击/触控操作。

## 16. 可访问性检查

- 使用 header、nav、main、complementary 等语义 landmark。
- 标题层级正确。
- 表单字段都有持久 Label。
- 纯图标按钮都有 accessible name。
- 键盘顺序与视觉顺序一致。
- sticky UI 不遮挡焦点。
- Dialog trap focus 并在关闭时恢复。
- Menu 使用正确 ARIA pattern。
- 多字段错误时提供可定位的错误摘要。
- 状态变化使用 `aria-live`，但避免过度播报。
- 颜色对比达到 WCAG 2.1 AA。
- 200% zoom 和窄视口可用。
- 屏幕阅读器能区分 unread、starred、selected、delivery state。
- 尊重 reduced motion。

## 17. 文案

- 默认 UI 语言：简体中文。
- 邮箱、RFC header、provider 名、技术 ID 保留规范写法。
- 使用明确动词：`写邮件`、`回复`、`转发`、`保存草稿`、`重试发送`。
- 能使用具体动词时，不使用模糊的 `确定`。
- 错误说明失败内容和下一步。
- 未收到 delivery webhook 前不得声称“已送达”。
- 日期按用户时区显示；hover/focus 或详情提供完整时间。

## 18. 明确禁止的模式

不得交付：

- 当前黑色竖向图标栏作为桌面主导航；
- serif/editorial 标题；
- paper-like 或杂志排版；
- 重阴影；
- 渐变或玻璃拟态；
- 过大的圆角卡片；
- 大量全大写；
- 极小、低对比元数据；
- 顶栏长期铺满装饰性状态 Chip；
- 一个页面组件承担全部应用状态和网络逻辑；
- raw HTML 邮件直接注入；
- essential action 只在 hover 出现；
- 仿冒 Cloudflare 品牌；
- 只实现浅色；
- 只实现桌面。

## 19. 实现要求

- 语义 token 集中在 `src/app.css` 或专门 token 文件。
- CSS variables 供 Tailwind utility 和组件使用。
- feature 组件不得散落重复的颜色字面量。
- 先构建 primitives，再构建应用组件。
- 对导航、深链接和浏览器历史有价值的状态应进入 URL。
- loading、empty、error、disabled、success 与主流程同批完成，不能留作未来工作。
- 如能安全排除生产，可添加开发专用组件画廊/design-system route。
- 设计决策改变时同步更新 `DESIGN.md`。

## 20. 视觉验收清单

只有满足以下条件，视觉重构才算完成：

- 桌面形成清晰的浅色侧栏 + 列表 + 详情工作区；
- 平板和手机无横向滚动，流程可用；
- light/dark/system 在首屏前正确生效；
- Button、Field、Badge、Banner、Dialog、Menu、Tabs 使用共享 primitives；
- 所有邮件状态有明确视觉处理；
- Sent 投递状态准确且可展开；
- Compose autosave 和错误可见；
- 键盘导航和 focus 完整；
- UI 不再像旧的 editorial/paper 概念；
- 能看出 Cloudflare 产品设计语言的启发，但 FlareMail 仍是独立、合法、可识别的产品。

## 21. 实施时重新核对的官方资料

只使用官方资料，并在实际编码时重新确认最新行为：

- Cloudflare SvelteKit on Workers 文档
- Cloudflare Email Service Workers API 文档
- Cloudflare D1 migrations 文档
- Cloudflare Dashboard 当前导航、KV UI、Observability UI、键盘快捷键和 Dark Mode 更新
- Cloudflare Design System 与无障碍文章
- Resend Send Email API 文档
- Resend idempotency key 文档
- Resend webhook 验签与事件类型文档
- Resend Message-ID/threading 文档

## 22. FlareMail 当前实现与目标组件映射

本节把规范中的职责映射到当前仓库，作为重构实施和审查的唯一路径索引。当前路径代表已有实现；目标路径代表应逐阶段落地的拆分。命名可按实现调整，但职责、边界和规范要求不得削弱。

### 22.1 应用壳层与导航

| 规范职责 | 当前路径 | 目标路径/改造边界 |
| --- | --- | --- |
| 页面入口与状态编排 | `src/routes/+page.svelte` | 保留路由入口；将网络、会话和工作区状态拆到服务端 load/API 与专门的 feature 状态模块，不让页面承担全部应用状态和网络逻辑 |
| 顶部栏、账号上下文、写信入口 | `src/lib/components/mail/WorkspaceHeader.svelte` | `src/lib/components/shell/AppTopbar.svelte`；技术状态进入 `ServiceStatusMenu.svelte`，不再常驻装饰性 Chip |
| 文件夹导航 | `src/lib/components/mail/MailSidebar.svelte` | `src/lib/components/shell/AppSidebar.svelte`；桌面宽度 224–248 px，移除黑色窄图标栏；平板使用 Drawer/折叠栏，手机使用 `MobileNavigation.svelte` |
| 移动端导航 | 当前缺失 | `src/lib/components/shell/MobileNavigation.svelte`，提供 App Bar、返回和所有触控可发现的必要操作 |
| 服务状态 | 当前散落在 `WorkspaceHeader.svelte`、`LoginView.svelte` | `src/lib/components/shell/ServiceStatusMenu.svelte`；只显示安全状态，不显示 secret 值 |
| 根布局/首屏主题 | `src/routes/+layout.svelte`、`src/app.html` | 在 `app.html` 首屏脚本应用 `light`/`dark`/`system`，`+layout.svelte` 提供语义 landmark 与全局状态 |

### 22.2 邮件工作区

| 规范职责 | 当前路径 | 目标路径/改造边界 |
| --- | --- | --- |
| 文件夹标题、数量、搜索、筛选、刷新 | `src/lib/components/mail/MessageListPane.svelte` 内部标题区 | `src/lib/components/mail/FolderHeader.svelte`、`MailSearchBar.svelte`、`MailFilterBar.svelte`；状态放 Banner/状态菜单 |
| 线程列表 | `src/lib/components/mail/MessageListPane.svelte` | `MessageList.svelte` + `MessageListItem.svelte`；行高 64–76 px，Skeleton/空/首次/错误/分页结束状态齐全 |
| 邮件详情编排 | `src/lib/components/mail/MessageDetailPane.svelte` | `MessageDetail.svelte` + `MessageHeader.svelte` + `MessageBody.svelte`；详情面板独立滚动，手机采用 drill-in 与返回 |
| 附件、HTML 与原始邮件 | `MessageDetail.svelte`、`MessageBody.svelte`、`AttachmentList.svelte`、`src/routes/api/workspace/messages/[id]/**` | 已实现 plain-text 默认、安全 HTML iframe、CID capability 与 ownership 下载；类型化预览和批量下载仍按 11.5 的隔离与内存边界实施 |
| 投递时间线 | `MessageDetailPane.svelte`、`src/routes/api/workspace/messages/[id]/delivery/+server.ts`、`src/lib/server/resend-webhook.ts` | `DeliveryTimeline.svelte`；展示 queued/submitted/sent/delivered/delayed/bounced/failed/complained/suppressed 及可选 opened/clicked，受理不得写成已送达 |
| 写信、回复、转发、自动保存 | `src/lib/components/mail/ComposeModal.svelte`、`src/routes/api/workspace/drafts/+server.ts`、`src/routes/+page.svelte` | `ComposeDialog.svelte`；桌面 Dialog/Sheet、手机全屏，sticky header/footer、dirty 关闭确认、autosave 状态与字段级错误 |
| 草稿空状态 | 当前由列表/页面条件分支提供 | `EmptyMailbox.svelte` 或对应 `EmptyState`；区分完成空、首次空、错误和分页结束 |

### 22.3 账户、设置和服务端边界

| 规范职责 | 当前路径 | 目标路径/改造边界 |
| --- | --- | --- |
| 登录 | `src/lib/components/mail/LoginView.svelte`、`src/routes/+page.server.ts`、`src/hooks.server.ts` | 使用无 demo 凭据的生产配置；登录面板保持中性 canvas，字段具备 autocomplete，错误对用户通用、细节只进安全日志 |
| 个人资料/设置 | `src/lib/components/mail/ProfilePane.svelte`、`src/routes/api/workspace/profile/+server.ts` | 按个人资料、发件身份、自动回复、通知、外观、诊断分区；供应商信息只在相关设置/诊断上下文出现 |
| 会话、工作区和消息 API | `src/routes/api/workspace/**`、`src/lib/server/workspace.ts`、`workspace-api.ts` | 保持 API 与 UI 状态边界；可深链状态进入 URL；加载、错误、成功结果具备明确 aria-live/视觉呈现 |
| D1/R2/Email Routing/Resend 适配 | `src/lib/server/cloudflare.ts`、`cloudflare-email.ts`、`email.ts`、`inbound-email.ts`、`outbound.ts` | 平台逻辑留在 `src/lib/server/` 与 `worker/index.ts`；UI 只消费安全、语义化状态 |
| Worker 入口和邮件事件 | `worker/index.ts` | 继续统一承载 `fetch` 与 `email()`；不把供应商技术标识提升为主导航 |
| 数据定义与迁移 | `schema.sql`（当前基线） | 新增按阶段编号的 `migrations/*.sql`；每次 D1 结构变更同步 schema、服务端类型/API 与本地迁移验证 |

### 22.4 共享 primitives 与 token

| 规范职责 | 当前路径 | 目标路径/改造边界 |
| --- | --- | --- |
| 语义颜色、间距、圆角、字体、motion | `src/app.css`（当前含旧 `editorial-heading`、paper/阴影和全局 `overflow: hidden`） | `src/app.css` 或专门 token 文件集中声明本规范 `--fm-*`、space/radius/motion；移除旧 editorial/paper token 和破坏移动滚动的全局限制 |
| Button/IconButton/Field/Select | 当前各组件内 Tailwind class | `src/lib/components/ui/Button.svelte`、`IconButton.svelte`、`TextField.svelte`、`TextArea.svelte`、`Select.svelte` 等；variant 仅有一个来源，loading 不改变宽度 |
| 状态、导航和反馈 | 当前内联按钮、文字、Badge | `Badge.svelte`、`StatusBadge.svelte`、`StatusDot.svelte`、`Banner.svelte`、`Alert.svelte`、`Toast.svelte`、`EmptyState.svelte`、`Skeleton.svelte`；状态不可只靠颜色 |
| 叠加层与菜单 | `ComposeModal.svelte` 及内联控件 | `Dialog.svelte`、`Drawer.svelte`、`Sheet.svelte`、`DropdownMenu.svelte`、`Tooltip.svelte`、`ConfirmDialog.svelte`；实现 focus trap、关闭恢复焦点和正确 ARIA pattern |
| 结构化数据与切换 | 当前列表内联实现 | `Table.svelte`/结构化列表、`Tabs.svelte`、`Checkbox.svelte`、`Switch.svelte`、`Pagination.svelte` 或 cursor loading |
| 图标 | 各组件内联 SVG | 统一 `lucide-svelte` 或少量本地图标组件；默认 16 px、导航 18–20 px，纯图标必须 accessible name + Tooltip |

## 23. 分阶段设计验证清单

每个阶段合并前必须完成适用项并保留命令/截图/浏览器结果作为证据；未验证项不得标记完成。

### 阶段 0：基线与安全

- [ ] `DESIGN.md`、`AGENTS.md` 和目标文档已审查，所有规范变更有对应实施路径。
- [ ] `src/app.css`、`src/routes/+layout.svelte`、`src/app.html` 的 token、滚动和主题现状已记录。
- [ ] 不提交真实 Cloudflare/Resend secret、生产 database_id、生产桶名或凭据。
- [ ] 不执行生产部署、不发送真实邮件；本地使用 mock/占位绑定完成验证。

### 阶段 1：tokens 与 primitives

- [ ] 4 px space、radius、控件高度和 `--fm-*` light/dark token 集中且无重复颜色字面量。
- [ ] Button、IconButton、Field、Badge、Banner、Dialog、Menu、Tabs 等由共享 primitives 渲染。
- [ ] variants、disabled/loading、focus、键盘操作、`aria-live` 和 reduced-motion 均有实现/测试证据。
- [ ] 文字/背景组合通过自动化 WCAG 2.1 AA 对比度检查。

### 阶段 2：桌面壳层与邮件工作区

- [ ] `>=1280px` 形成 48–52 px 顶栏、224–248 px 侧栏、360–420 px 列表和约 520 px 详情最小宽度。
- [ ] 侧栏不再是黑色竖向图标栏；导航按收件箱、已发送、草稿箱、设置组织。
- [ ] 文件夹标题有搜索/筛选/刷新/必要 Banner；技术 provider health 不常驻标题。
- [ ] 列表包含未读、对端、主题、预览、时间、星标、线程数和已发送投递状态。
- [ ] 列表具备 Skeleton、完成空、首次空、错误和分页结束状态；次级操作不误触主选择。
- [x] 详情正文默认 plain text；HTML sandbox、CID/附件/原文 ownership、外链安全和远程图片显式加载规则均可验证。
- [ ] 已发送时间线准确区分 accepted/queued 与 delivered，并支持展开和失败重试。

### 阶段 3：写信、登录与设置

- [ ] Compose 桌面宽度约 760–900 px，字段、sticky footer、保存/发送/取消和 autosave 状态完整。
- [ ] dirty draft 关闭有安全选择；字段错误靠近字段；发送只在无效或提交中禁用。
- [ ] Dialog/Sheet trap focus，关闭后恢复触发按钮焦点；手机全屏且兼容 safe area。
- [ ] 登录无生产 demo 凭据、字段 autocomplete 正确、错误不泄露基础设施细节。
- [ ] 设置按六类任务分区；诊断仅显示安全状态和安全 ID。

### 阶段 4：主题、响应式和可访问性

- [ ] `light`、`dark`、`system` 首屏绘制前生效；显式选择持久化，system 跟随系统变化。
- [ ] `768–1279px` 使用折叠栏/Drawer 和明显返回；`<768px` 一次仅一个主面板并无横向滚动。
- [ ] 手机所有触控目标至少 44 × 44 CSS px，必要操作不依赖 hover。
- [ ] landmark、标题层级、持久 Label、键盘顺序、ARIA pattern、错误摘要和 `aria-live` 均通过检查。
- [ ] 200% zoom、窄视口、屏幕阅读器能区分 unread/starred/selected/delivery state。
- [ ] `/ c g+i g+s g+d j k r f ? Escape` 均有点击/触控等价操作，并在输入框/编辑器内按规则禁用。

### 阶段 5：全量验收

- [ ] `bun run check` 通过。
- [ ] 涉及 Worker、D1、R2 或 Email Routing 时 `bun run build` 或 `bun run preview` 通过。
- [ ] 本地 mock/占位环境完成登录、导航、列表、打开邮件、读/未读、星标、写信、回复、转发、草稿、发送、重试和下载流程。
- [ ] 浏览器检查覆盖桌面、平板、手机及 light/dark/system；留存无横向滚动、focus 和关键状态截图/结果。
- [ ] 审查明确禁止项：无黑色窄栏主导航、serif/editorial、paper、重阴影、渐变、玻璃拟态、大圆角卡片、全大写、低对比元数据、供应商 Chip 泛滥、raw HTML 注入、hover-only action、仿冒 Cloudflare、仅浅色或仅桌面。
- [ ] 数据库迁移、API、UI、Worker 和文档版本一致；每个阶段有独立 Conventional Commit，未把无关工作树改动纳入提交。
