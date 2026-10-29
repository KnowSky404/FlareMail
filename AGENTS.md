# Repository Guidelines

## 默认开发工作流

所有功能迭代、问题修复、重构、测试、配置及文档/约束更新统一使用以下工作流；小修复也不跳过 worktree、本地 `/review`、提交和 PR 流程：

**独立本地 worktree + 任务分支 → 本地实现、验证和原子提交 → 每次 push / 创建 PR 前完成本地 `/review` 并解决问题 → 推送任务分支并提交 PR → 当前 head 的 Codex 机器人 review 完成并处理反馈 → rebase 合并到 `main` → 核对并同步主分支 → 删除已合并的本地/远端任务分支及 worktree**。

- 开始修改前，从已核对的最新 `origin/main` 创建独立 worktree 和新分支；继续已有任务则复用对应 worktree/分支。禁止直接在 `main` 或用户正在使用的工作树中修改。
- 本地验证通过后创建原子提交；每次 push 和创建 PR 前分别执行本地 `/review`，解决有效问题并复审通过后才可继续。功能改动提 PR 前仍需完成下文要求的 PRE 验收；纯文档/约束更新无需部署 PRE，但同样执行本地 `/review`。
- 提交 PR 或推送新提交后，主动检查 Codex 机器人 review 是否已触发；有 review 时必须等待其针对当前 head 完成并处理反馈，才可合并。尚未出现 review 不代表未启用，不得据此立即合并；本仓库已启用的 Code Review 和 Security Review 按下文门禁执行。
- PR 默认以 `main` 为目标并使用 rebase 合并；合并前完成当前 head 的 Code Review、Security Review 及反馈处理。确认实际合并并核对改动已进入主分支后，默认完成本任务的分支和 worktree 清理；未合并、含未保存改动或用户要求保留时不得删除。
- 用户已将本流程设为仓库默认授权：在用户要求修改的任务范围内，完成门禁后自主推进任务分支 push、创建 PR、review 通过后的 rebase 合并及本任务分支/worktree 清理，无需逐步重复确认。用户明确要求仅本地、暂不推送/提 PR/合并或保留分支/worktree 时遵从该限制。此授权不包含直接推送 `main`、Preview/生产部署、远程迁移或生产数据写入；这些操作仍按对应授权和门禁执行。具体见下文“本地 `/review` 门禁”“本地优先与发布顺序”和“Rebase 合并与任务收尾”。

## 项目结构与模块组织

`src/` 是 SvelteKit 主应用目录。页面放在 `src/routes/`，接口使用 `+server.ts`，例如 `src/routes/api/messages/+server.ts`。纯邮件契约放在 `src/lib/domain/mail/`；仅服务端可用的认证、D1、入站、出站与工作区逻辑放在 `src/lib/server/`。Worker 包装入口位于 `worker/index.ts`，统一承载网页/API 的 `fetch` 与 Email Routing 的 `email()`。D1 变更以 `migrations/` 为权威顺序，`schema.sql` 只是最新结构快照。`build/`、`.svelte-kit/`、`.wrangler/` 均为构建产物，不要手改。

## 工具与依赖版本

- Bun 默认使用本机最新已安装的稳定版；开工时核对 `command -v bun` 与 `bun --version`，确保非交互 shell 解析到预期版本。不要为了匹配旧记录下载或切换旧版，也不要把“本机最新”理解为每次任务都执行全局升级。
- `package.json` 的 `engines.bun` 是最低支持版本；`packageManager` 是 CI 的可复现基准，不要求本地版本与之完全相等。CI 从 `package.json` 读取版本，避免多个位置重复硬编码。更新基准时先在本机完成相关验证。
- 项目依赖安装默认使用 `bun install --frozen-lockfile`。只有明确调整依赖时才用 `bun install` 或 `bun update` 更新 `bun.lock`，并将依赖声明和锁文件一起提交。Bun 运行时更新不意味着批量更新依赖。
- 本地构建、迁移和测试优先使用项目脚本及锁定的 Wrangler。原生 Worker Preview 要求 Wrangler >= 4.135.0；此时按 [Preview 指南](docs/PREVIEW.md) 检查较新全局 CLI 的版本和命令帮助，不把该例外扩展到其他命令，也不为普通任务自动升级依赖。
- 库、SDK、CLI 或云服务的用法、配置和版本迁移先查 Context7：先 `resolve-library-id`，再用匹配的库 ID 调用 `query-docs`；用户给出精确 ID 时可直接查询。工具未列出时先发现工具，确认不可用后再用官方文档及已安装版本的帮助/类型核对。纯业务逻辑调试、重构和代码审查无需为此查询文档。
- 安装全局 JavaScript CLI 时依次优先 Bun、pnpm、npm，并确认非交互 shell 能找到二进制；不要将本机工具安装混入项目依赖更新。

## 构建、测试与开发命令

- `bun install --frozen-lockfile`：按现有锁文件安装依赖
- `bun run dev`：启动本地 SvelteKit 开发环境
- `bun run check`：执行类型检查与路由校验
- `bun run build`：构建 Cloudflare Workers 产物
- `bun run preview`：用 Wrangler 本地预览 Worker
- `bun run test`：运行 `src/` 与 `scripts/` 的 Bun unit/integration 测试
- `bun run db:migrate:local`：顺序应用 `migrations/` 到本地 D1
- `bun run deploy:dry-run`：从公开本地配置生成临时配置，构建并校验 Worker 打包；不读取私有生产配置、不发布
- `bun run release:preflight -- --json`：检查干净提交及本地发布门禁，不执行远程部署或远程迁移
- `bun run deploy`：使用私有 `wrangler.deploy.toml` 构建并发布生产 Worker，仅在明确授权生产发布时使用

## Worktree 与分支隔离

- 所有功能开发、修复、重构及相关测试、配置、文档改动，必须先为当前任务创建独立 Git worktree 和新分支，再在该 worktree 内修改、验证和提交。纯文档/开发约束更新也使用独立 worktree 和分支。禁止直接在 `main` 或用户正在使用的工作树中开发。
- 开工检查 cwd、分支、上游、工作树状态和 `git worktree list`；从已核对的最新 `origin/main` 创建任务分支（如 `feat/<topic>`、`fix/<topic>`、`docs/<topic>`）。明确继续已有任务时复用该任务的 worktree/分支，不另建重复分支；其他基线需有用户明确要求。
- worktree 放在仓库外的同级目录或可写临时目录，记录绝对路径、分支和基线 SHA。依赖、构建产物、本地 D1/R2、浏览器测试状态和端口分别隔离；不要复用其他工作树的可写生成目录，也不要自动复制私有配置或密钥。具体步骤见 [开发指南](docs/DEVELOPMENT.md#worktree-and-pr-workflow)。
- 保留原工作树和无关改动，不擅自 reset、stash、rebase、force-push 或删除 worktree/分支。未合并任务及其验收证据保留供继续开发和审查；已获授权并完成合并的任务按下方收尾流程清理，用户要求保留时除外。

## 本地优先与发布顺序

默认顺序：**独立 worktree + 新分支 → 本地实现与验证 → 原子提交 → 按授权完成 PRE（远程 Preview）部署与验收 → 每次 push / 创建 PR 前本地 `/review` 并解决问题 → 推送任务分支并提 PR → 等待当前 head 的 Codex 机器人 review 完成并处理反馈 → rebase 合并到 `main` → 核对并同步主分支 → 清理任务 worktree/分支 → 按授权部署生产**。任务分支 push、PR、rebase 合并和清理采用上述默认授权；Preview、生产部署及其他远程操作仍需各自授权，不由 Git 流程推定。

1. 先在隔离本地 D1/R2 和 demo/fake provider 上实现、验证，再提交当前任务。不要用共享 Preview 数据做 fixture、自动化测试或破坏性验收。
2. 需要远程验收且用户已授权发布 Preview 时，先通过本地门禁和打包检查，再按 [Preview 指南](docs/PREVIEW.md) 发布已验证的提交。未指定生产的发布请求优先使用 Preview，不直接调用 `bun run deploy`。普通修复、审查或约束更新不自动触发部署。
3. 区分 `bun run preview`（本地 Worker）、`wrangler preview`（原生远程 Preview）和 `wrangler versions upload`（版本预览）。原生 Preview 是默认远程验收方式；需要复用生产既有 secrets 检查上传版本时，按指南使用版本预览。不得用 `wrangler deploy` 代替 Preview 发布，也不得擅自执行 `versions deploy` 或 `triggers deploy`。
4. 当前 Preview 有意共用生产 D1/R2 和 Owner，发布代码不切换生产流量，但写入会影响生产数据。默认只读验收；写入、真实邮件/Telegram、远程迁移或路由/DNS 变更必须在用户授权范围内。已明确授权的同一范围无需重复确认。不要为发布 Preview 初始化 Owner、重置数据库或自动创建/删除云资源。
5. Preview 发布后记录提交 SHA、URL、部署/版本 ID，核对登录、相关页面/API、绑定和生产流量指向。`/api/health` 只证明存活；数据库/绑定就绪另查已认证的 `/api/readiness`。Preview HTTP 验收不能证明生产 `email()`、Cron 或真实投递。
   功能改动只有在对应提交完成 PRE 相关页面/API 验收后才可提 PR；仅发布成功或健康检查通过不算验收完成。PR 后追加影响实现的提交，必须补做受影响的本地验证和 PRE 验收后才能合并。PRE 无法覆盖的 handler 需记录替代验证路径；环境阻塞不能记为通过或自动跳过，绕过此门禁需用户明确授权。纯文档/约束改动完成差异、命令、链接检查及本地 `/review` 后即可提 PR，无需为此部署 PRE。
6. 生产发布是后续独立步骤，需要明确生产授权；按 [生产清单](docs/PRODUCTION_CHECKLIST.md) 核对同一提交的本地验证、依赖审计、迁移兼容性及回退边界。原则上先保留对应 Preview 验收证据；首次部署、事件处理或 Preview 无法覆盖的 handler 变更需说明替代验证路径。
7. GitHub Actions 仅在发布 Release 或手动触发时扫描依赖安全，普通 push/PR 不触发。测试、浏览器 QA、构建和部署在本机执行，仍需按当前提交保留验证证据。发版后触发的扫描不能代替生产部署前的本地依赖审计。

## 编码风格与命名约定

统一使用 TypeScript、ES Modules 和 2 空格缩进。遵循 SvelteKit 文件约定：页面使用 `+page.svelte`、服务端加载使用 `+page.server.ts`、接口使用 `+server.ts`。Cloudflare 绑定统一通过 `CloudflareEnv` 类型声明。服务端模块按职责命名，如 `email.ts`、`cloudflare.ts`。优先写小函数、显式返回结构，避免把平台相关逻辑散落到页面组件中。

## 测试与验证要求

- 代码、测试或运行配置改动提交前运行 `bun run test`、`bun run check`、`bun run build`。纯文档/约束改动检查差异、命令和链接即可；若同时修改校验脚本或 CI，仍执行代码门禁。不要重复运行已经通过且不受后续改动影响的检查。
- 测试与目标模块相邻，使用 `*.test.ts` 命名，覆盖行为和回归边界，避免仅复制实现的断言。接口变更验证实际涉及的接口及认证/错误路径，不以健康接口代替业务验收。
- 浏览器交互变更运行相关 Chromium 桌面、手机和窄屏 QA；键盘、弹层、布局和可访问性变更补充相关 a11y 及 WebKit/Firefox 验证。发布时遵循本地门禁和生产清单，另记录已触发的 GitHub 发版安全扫描。保留必要截图；Linux WebKit 不等于真实 iOS/Safari，环境缺失和跳过项需如实报告。
- `check`、`build`、typegen、dry-run 和浏览器套件会共享 `.svelte-kit/`、`build/` 等状态，串行执行；多个验证进程需独立 worktree 和测试状态目录。不要为通过预检暂存、丢弃或提交他人的未完成改动，可在干净的隔离 worktree 验证目标提交。
- D1 migration 只追加，不修改已发布文件；同步 `schema.sql`、schema version 与相关类型/契约，同时验证空库、legacy fixture 和快照一致性。远程执行前核对目标、待应用列表、恢复点及当前生产代码兼容性，完成后核对迁移记录和 schema。
- 绑定或 compatibility date/flags 变更同步相关公开配置/模板；运行 `bun run cf:typegen` 更新 `worker-configuration.d.ts`，不要手改生成类型。私有部署配置按目标环境核对，不复制真实资源标识到公开文件。

## 本地 `/review` 门禁

- 每次向远端推送任务提交和每次创建 PR 前，必须分别在本任务 worktree 中实际执行 Codex 内置 `/review`；首次 push、追加提交、机器人反馈修复、基线同步及纯文档/约束更新均不例外。只查看 diff、口头自检、测试通过或等待远端机器人均不能代替该步骤。合并后的远端分支条件删除按收尾流程执行。
- 审查范围覆盖相对目标分支 `origin/main` 的完整任务差异，不能只审最后一次提交或空的未提交差异。交互式 `/review` 选择基线分支审查；非交互环境可运行 `codex review --base origin/main`，用法以本机 `codex review --help` 为准。参考[官方本地 review 指南](https://learn.chatgpt.com/docs/code-review#review-local-changes)。
- 逐条核实审查意见，修复所有确认的问题，对误报或不适用项记录依据；修复后完成受影响的本地验证、原子提交及所需 PRE 验收，再次执行 `/review`，直到没有未解决的有效问题。不能把问题留到 push 或 PR 后再处理。
- 保存审查命令/范围、时间、基线 SHA、被审查的 head SHA、结果和问题处理依据；push/PR 前核对最终 head、差异和基线与审查记录一致。审查后有任何修改、新提交、rebase 或冲突解决，先重新验证并执行 `/review`，不得复用旧结果。PR 附本地审查证据，后续提交更新对应记录。
- `/review` 不可用、失败、未完成或缺少可核对的通过记录时，保留本地分支/worktree 并报告阻塞，不推送任务提交、不创建 PR。已创建的 PR 保留但不能合并。本地 `/review` 与 PR 上 Codex 机器人的 Code Review、Security Review 是独立门禁，均需通过。

## 提交与 Pull Request 规范

- 开工先检查 cwd、分支、上游、工作树和已有改动；保留无关用户改动，不擅自清理、reset、stash、rebase 或 force-push。
- 除非用户明确要求不提交，当前任务的相关改动完成验证后创建原子提交，使用 `type(scope): summary`。不要为每次文件编辑立即提交，不创建空提交，不混入无关或私有文件；验证失败或无法安全提交时报告原因。
- 本地提交、push、PR、Preview 与生产发布分别处理。任务分支 push/PR 按默认授权和本地 `/review` 门禁执行；要求观察 CI 时跟踪推送的确切 SHA 到所需任务的终态，不能以 push 成功代替 CI 成功。
- 功能 PR 以 `main` 为目标分支，附 worktree/分支、基线及验收 SHA、本地门禁与 `/review` 记录、PRE URL/部署或版本 ID、相关业务验收和未覆盖项；纯文档 PR 同样附本地 `/review` 记录并明确 PRE 不适用。PRE 未验收完成时交付分支、提交和阻塞原因，不提前创建功能 PR。
- 所有 PR（包括纯文档/约束更新）合并前必须等待 Codex 机器人对当前 head SHA 的 review 完成。当前机器人为 `chatgpt-codex-connector[bot]`（`gh` 部分输出省略 `[bot]`）；核对真实作者和每项审查对应的提交。当前已启用 Code Review 和 Security Review，两项均需完成；优先检查机器人 `Codex Review Summary` 的各项状态/提交及相关 review、行内评论，不仅检查 GitHub Actions。`CLEAN`、无 checks、旧提交的 review、👀、单独的 👍 或 `COMMENTED` 均不能代替当前提交的有效完成凭据；汇总中的单个 `status`/`headSha` 也不能代替所有审查项的核对。
- Review 完成后逐条核实反馈：修复确认的问题并完成受影响验证，误报或不适用项记录依据；未处理的有效问题不能合并。修复提交在 push 前再次通过本地 `/review`；追加任何提交后重新等待针对新 head 的完整机器人 review，按现有规则补做受影响的本地/PRE 验收。审查未完成、失败或缺少对应当前 head 的凭据时保留 PR、分支和 worktree，报告状态，不以等待超时或跳过审查继续合并；不提前启用可能绕过此审查门禁的 auto-merge。交付时记录 review 完成时间、审查 SHA 和结果链接。
- 当前任务在本地及机器人 review 均通过、有效问题均已处理后，按默认授权使用 rebase 合并并收尾，无需再次询问；用户限制合并或指定其他策略时遵从。直接推送 `main` 和生产部署仍需要各自的明确授权；用户明确要求直接推送时仍保留本地 `/review` 及本地/PRE 门禁。生产默认部署已进入 `origin/main` 的干净提交；合并、squash 或冲突解决后核对最终 SHA 与 PRE 内容，内容变化时重新验证并验收，遵循生产清单的准确提交门禁。
- PR 写清问题、最终行为、影响和验证；UI 附截图，D1/绑定写明迁移与配置。GitHub CLI 的正文默认先写受引号保护的 heredoc 临时文件，再传 `--body-file`。
- 更新公开行为或操作契约时同步相应开发、Preview、部署/API 和中英文说明；历史验收记录保留当时版本与证据，不改写成当前结论。大段验收历史放专门记录，不堆入 README 或本文件。

### Rebase 合并与任务收尾

1. 合并前核对 PR 的目标 `main`、head SHA、提交/文件范围、可合并状态和所需检查，并确认该 head 的 Codex Code Review、已启用的 Security Review 均已完成且反馈已处理；使用 `gh pr merge <PR> --rebase --match-head-commit <HEAD_SHA>` 锁定已验证和审查的提交。不以 `--admin` 绕过检查；自动合并或进入队列不算已合并，等待实际 `MERGED` 后再清理。
2. 合并后记录 PR URL、原 head SHA 和合并 SHA，fetch `origin/main` 并确认合并 SHA 已进入主分支。Rebase 会改写 SHA，用 PR 合并记录及补丁/内容对比核实任务改动完整进入 `main`；不能仅凭原 SHA 不再是祖先判定丢失，也不能仅凭分支已推送认定合并成功。内容变化时补做受影响验证和 PRE 验收。
3. 原主工作树在 `main` 且干净、无分叉时，用 `git merge --ff-only origin/main` 同步；有用户改动或无法快进时保留现场并报告，不 reset、stash 或自动 rebase。此阻塞不妨碍已证实合并且可安全清理的任务收尾。
4. 默认清理本任务已合并的 worktree、本地及远端分支。先确认任务分支仍指向 PR 已合并的 head，没有新增提交；检查暂存、未提交、未跟踪文件及需保留的忽略文件，妥善保存验收记录和私有配置，并停止该任务的临时服务。从保留的主工作树运行 `git worktree remove <PATH>`，再删除本地及远端任务分支，不使用 `worktree remove --force`，不删除其他任务或主工作树。
   远端删除必须用已核实的 PR head 作显式 lease：`git push --force-with-lease=refs/heads/<BRANCH>:<VERIFIED_HEAD_SHA> origin :refs/heads/<BRANCH>`。这是只允许删除指定旧 SHA 的保护，不授权覆盖分支；禁止无条件 `--delete` 或 `--force`。远端已不存在时记录即可；lease 被拒绝则保留远端分支并报告，不改成新 SHA 重试删除未经合并的提交。
5. 本地分支优先用 `git branch -d <BRANCH>`；若仅因 rebase 改写祖先关系被拒绝，必须先以 PR `MERGED`、主分支合并 SHA、任务 head 未变化及补丁等价证据确认改动已保留，才可对该任务分支使用 `-D`。有未保存文件、未合并提交、其他 worktree 占用或用户要求保留时停止对应清理并报告。最后核对 PR 状态、本地/远端 `main`、工作树状态、任务分支和 worktree 是否已移除；交付 PR URL、最终 SHA、验证及未完成项，不把合并或清理视为生产部署。

## 安全与配置提示

不要提交真实的 Cloudflare 凭据、`database_id`、生产桶名称或密钥。修改 `wrangler.toml`、`schema.sql`、邮件接收逻辑时，保持 D1、R2 与 API 字段定义一致。

私有 `.env`、`.dev.vars` 和部署配置保持 Git 忽略，密钥文件权限使用 `0600`。命令输出、截图和共享记录不得暴露密码、Token、Cookie、邮件正文或完整收件地址。未经明确授权不进行生产数据清理、恢复、资源删除、密钥轮换或邮件路由变更。

给用户访问的开发服务优先监听 `::` 并用 `ss -lntp` 核对 IPv4/IPv6；提供 `http://oc-de-fra-1.knowsky.uk:<port>`，不要提供只能在本机打开的 localhost 地址。无人使用的临时验证服务及时停止。

交付时区分本地/mock、CI、Preview、生产部署、远程迁移和真实供应商证据，报告已验证项、未验证项及提交 SHA，不把构建或健康检查成功扩展为真实收发信成功。
