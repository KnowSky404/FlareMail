# Gemini UI Prompt

请基于当前 `FlareMail` 仓库，专注做一轮 **UI 外观美化**，不要改动已有业务逻辑、接口路径和状态流。

## 项目背景

- 技术栈：`SvelteKit + TypeScript + Tailwind CSS`
- 部署目标：`Cloudflare Workers`
- 当前功能已经验证通过：
  - 真实入站邮件展示
  - 邮件详情正文加载
  - `.eml` 原始邮件下载
  - 已读 / 星标 / 删除持久化
  - 草稿保存与已发送记录持久化

## 你的任务

请只做 **视觉改版和交互层级优化**，目标是让产品更像一个成熟、克制、极简的邮件工作台，而不是原型页或仪表盘。

## 设计方向

- 风格：极简、编辑感、留白充足、层级清楚
- 气质：偏专业工具，不要花哨，不要卡片堆叠过重
- 视觉关键词：
  - paper-like
  - editorial
  - calm
  - premium
  - intentional
- 不要：
  - 紫色系
  - 过重阴影
  - 典型后台 dashboard 风
  - 炫技动画
  - 改成深色主题优先

## 重点优化范围

- `src/app.css`
- `src/routes/+page.svelte`
- `src/lib/components/mail/LoginView.svelte`
- `src/lib/components/mail/WorkspaceHeader.svelte`
- `src/lib/components/mail/MailSidebar.svelte`
- `src/lib/components/mail/MessageListPane.svelte`
- `src/lib/components/mail/MessageDetailPane.svelte`
- `src/lib/components/mail/ProfilePane.svelte`
- `src/lib/components/mail/ComposeModal.svelte`

## 强约束

- 不要改动 API 路径
- 不要改动组件对外事件语义
- 不要删除任何已存在功能按钮
- 不要新增第三方依赖
- 保持 `Svelte + TypeScript` 现有写法
- 响应式必须同时兼顾桌面端和移动端
- 可以重排布局，但不要破坏：
  - 登录
  - 收件箱
  - 线程查看
  - 详情查看
  - 资料编辑
  - 草稿 / 已发送
  - 写信弹窗

## 我希望你输出的内容

请直接输出可落地的代码修改方案，优先给：

1. 更新后的文件内容
2. 每个文件的改动目的
3. 你为什么这样调整视觉层级

## 额外说明

- 当前业务逻辑已经基本跑通，所以请把注意力放在：
  - 布局秩序
  - 字体层级
  - 间距系统
  - 分栏比例
  - 信息密度
  - 状态标签样式
  - 登录页和工作台首页的一致性
- 如果需要统一主题变量，请优先在 `src/app.css` 中整理。
