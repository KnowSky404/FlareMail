<script lang="ts">
  import { demoCredentials, type LoginInput } from '$lib/mock/mailbox';

  let {
    runtimeLabel,
    dbBound,
    bucketBound,
    totalMessages,
    lastSubject,
    loginError = '',
    pending = false,
    onLogin
  }: {
    runtimeLabel: string;
    dbBound: boolean;
    bucketBound: boolean;
    totalMessages: number;
    lastSubject: string | null;
    loginError?: string;
    pending?: boolean;
    onLogin: (payload: LoginInput) => void | Promise<void>;
  } = $props();

  let email = $state(demoCredentials.email);
  let password = $state(demoCredentials.password);
  let remember = $state(true);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onLogin({
      email,
      password,
      remember
    });
  }
</script>

<main class="mx-auto grid min-h-screen w-full max-w-7xl items-center gap-8 px-5 py-8 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
  <section class="space-y-10 rounded-[2rem] border border-night/10 bg-shell/92 p-7 shadow-[0_24px_80px_rgba(32,27,22,0.06)] md:p-10">
    <div class="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-mist">
      <span class="rounded-full border border-night/10 px-3 py-1">FlareMail</span>
      <span class="rounded-full border border-night/10 px-3 py-1">{runtimeLabel}</span>
      <span class="rounded-full border border-night/10 px-3 py-1">Workspace API</span>
    </div>

    <div class="max-w-4xl space-y-5">
      <h1 class="font-display text-5xl leading-none tracking-[-0.04em] text-ink md:text-7xl">
        极简邮件工作台，先把收发与身份管理的体验打磨清楚。
      </h1>
      <p class="max-w-2xl text-base leading-7 text-mist md:text-lg">
        当前工作台已接入固定登录账号、个人资料接口和邮件操作接口。你可以刷新页面验证会话、编辑资料、收发邮件并查看工作区状态。
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-3">
      <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
        <p class="text-[11px] uppercase tracking-[0.24em] text-mist">登录入口</p>
        <p class="mt-3 text-2xl font-semibold text-ink">Cookie 会话</p>
        <p class="mt-3 text-sm leading-6 text-mist">
          登录后由 SvelteKit API 设置会话 Cookie，页面刷新后仍可恢复工作台状态。
        </p>
      </article>

      <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
        <p class="text-[11px] uppercase tracking-[0.24em] text-mist">工作台数据</p>
        <p class="mt-3 text-2xl font-semibold text-ink">工作区接口驱动</p>
        <p class="mt-3 text-sm leading-6 text-mist">
          收件箱、草稿箱、已发送、资料保存、收信与发信都通过 `/api/workspace/*` 接口完成。
        </p>
      </article>

      <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
        <p class="text-[11px] uppercase tracking-[0.24em] text-mist">运行时状态</p>
        <p class="mt-3 text-2xl font-semibold text-ink">D1 / R2 可见</p>
        <p class="mt-3 text-sm leading-6 text-mist">
          D1: {dbBound ? '已绑定' : '未绑定'} / R2: {bucketBound ? '已绑定' : '未绑定'}
        </p>
        <p class="mt-2 text-sm leading-6 text-mist">真实消息数：{totalMessages}</p>
        <p class="mt-1 text-sm leading-6 text-mist">最新主题：{lastSubject ?? '暂无真实来信'}</p>
      </article>
    </div>
  </section>

  <section class="rounded-[2rem] border border-night/10 bg-shell/95 p-7 shadow-[0_24px_80px_rgba(32,27,22,0.08)] md:p-8">
    <div class="space-y-3">
      <p class="text-[11px] uppercase tracking-[0.28em] text-mist">登录入口</p>
      <h2 class="font-display text-4xl leading-none text-ink">进入 FlareMail</h2>
      <p class="text-sm leading-6 text-mist">
        当前先用固定账号进入工作台，后续再接真实鉴权、用户表和邮件持久化。
      </p>
    </div>

    <form class="mt-8 space-y-5" onsubmit={submit}>
      <label class="block space-y-2">
        <span class="text-sm text-mist">邮箱</span>
        <input
          bind:value={email}
          class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-base text-ink outline-none transition focus:border-accent"
          type="email"
        />
      </label>

      <label class="block space-y-2">
        <span class="text-sm text-mist">密码</span>
        <input
          bind:value={password}
          class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-base text-ink outline-none transition focus:border-accent"
          type="password"
        />
      </label>

      <label class="flex items-center justify-between rounded-2xl border border-night/10 bg-paper px-4 py-3 text-sm text-mist">
        <span>7 天内记住我</span>
        <input bind:checked={remember} class="h-4 w-4 accent-accent" type="checkbox" />
      </label>

      {#if loginError}
        <p class="rounded-2xl border border-coral/20 bg-coral/8 px-4 py-3 text-sm text-coral">
          {loginError}
        </p>
      {/if}

      <button
        class="w-full rounded-full bg-ink px-5 py-3 text-sm font-medium text-paper transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? '正在登录…' : '登录并进入工作台'}
      </button>
    </form>

    <div class="mt-6 rounded-[1.75rem] border border-night/10 bg-paper p-5 text-sm leading-6 text-mist">
      <p class="font-medium text-ink">测试账号</p>
      <p class="mt-2 font-mono text-xs text-ink">{demoCredentials.email}</p>
      <p class="font-mono text-xs text-ink">{demoCredentials.password}</p>
    </div>
  </section>
</main>
