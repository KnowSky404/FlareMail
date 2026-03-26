<script lang="ts">
  import type { UserProfile } from '$lib/mock/mailbox';

  const createProfileDraft = (profile: UserProfile): UserProfile => ({ ...profile });

  let {
    profile,
    status = '',
    pending = false,
    onSave
  }: {
    profile: UserProfile;
    status?: string;
    pending?: boolean;
    onSave: (next: UserProfile) => void | Promise<void>;
  } = $props();

  let nextProfile = $state<UserProfile>(
    createProfileDraft({
      name: '',
      role: '',
      email: '',
      company: '',
      location: '',
      timezone: '',
      forwardingEnabled: false,
      signature: ''
    })
  );

  $effect(() => {
    nextProfile = createProfileDraft(profile);
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void onSave(nextProfile);
  }
</script>

<section class="paper-card flex flex-col overflow-hidden rounded-2xl">
  <div class="border-b border-line bg-shell/50 p-6 lg:p-8">
    <p class="meta-text text-gold">账户设置</p>
    <h2 class="editorial-heading mt-2 text-3xl text-ink lg:text-4xl">个人身份与偏好</h2>
  </div>

  <div class="flex-1 overflow-y-auto p-6 lg:p-8">
    <form class="mx-auto max-w-2xl space-y-10" onsubmit={submit}>
      <div class="space-y-6">
        <p class="meta-text">基础信息</p>
        <div class="grid gap-6 md:grid-cols-2">
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">邮箱地址</span>
            <input
              bind:value={nextProfile.email}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="email"
            />
          </label>
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">显示姓名</span>
            <input
              bind:value={nextProfile.name}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="text"
            />
          </label>
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">职位角色</span>
            <input
              bind:value={nextProfile.role}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="text"
            />
          </label>
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">公司名称</span>
            <input
              bind:value={nextProfile.company}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="text"
            />
          </label>
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">所在时区</span>
            <input
              bind:value={nextProfile.timezone}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="text"
            />
          </label>
          <label class="block space-y-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-mist">所在地区</span>
            <input
              bind:value={nextProfile.location}
              class="w-full border-b border-line bg-transparent py-2 text-sm text-ink outline-none transition focus:border-gold"
              type="text"
            />
          </label>
        </div>
      </div>

      <div class="space-y-6">
        <p class="meta-text">邮件偏好</p>
        <div class="space-y-4">
          <label class="flex items-center justify-between rounded-lg border border-line bg-paper/30 p-4 transition-colors hover:bg-paper/50">
            <div class="space-y-1">
              <p class="text-xs font-bold text-ink">转发入站邮件</p>
              <p class="text-[10px] text-mist">将收到的所有邮件转发到备用邮箱。</p>
            </div>
            <input bind:checked={nextProfile.forwardingEnabled} class="h-4 w-4 rounded-sm border-line text-gold focus:ring-gold" type="checkbox" />
          </label>
        </div>
      </div>

      <div class="space-y-6">
        <p class="meta-text">邮件签名</p>
        <label class="block space-y-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-mist">个性化签名 (Markdown)</span>
          <textarea
            bind:value={nextProfile.signature}
            class="min-h-[120px] w-full border border-line bg-transparent p-4 text-sm leading-relaxed text-ink outline-none transition focus:border-gold"
            placeholder="此致，"
          ></textarea>
        </label>
      </div>

      {#if status}
        <p class={`text-xs font-medium ${status.includes('成功') || status.includes('已保存') ? 'text-accent' : 'text-coral'}`}>
          {status}
        </p>
      {/if}

      <div class="flex items-center gap-4 pt-4">
        <button
          class="bg-ink px-8 py-3 text-[10px] font-bold uppercase tracking-widest text-paper transition-all hover:bg-accent disabled:opacity-50"
          disabled={pending}
          type="submit"
        >
          {pending ? '正在保存...' : '保存设置'}
        </button>
        <p class="text-[10px] text-mist italic">
          所有设置会立即同步到 D1 数据库。
        </p>
      </div>
    </form>
  </div>
</section>
