import type { CloudflareEnv } from '$lib/server/cloudflare';
import { refreshMailDomainHealth } from '$lib/server/mail-identities/health-refresh';
import { dispatchTelegramOutbox } from '$lib/server/telegram/dispatcher';

export interface ScheduledExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledMaintenanceDependencies {
  dispatchTelegram?: () => Promise<unknown>;
  refreshMailHealth?: () => Promise<unknown>;
  onFailure?: (task: 'telegram_outbox' | 'mail_domain_health') => void;
}

/** Starts independent scheduled tasks so one rejected provider task cannot suppress another. */
export function scheduleMaintenance(
  env: CloudflareEnv,
  context: ScheduledExecutionContext,
  dependencies: ScheduledMaintenanceDependencies = {}
) {
  const tasks: Array<[ 'telegram_outbox' | 'mail_domain_health', () => Promise<unknown> ]> = [
    ['telegram_outbox', dependencies.dispatchTelegram ?? (() => dispatchTelegramOutbox(env, { limit: 10, timeBudgetMs: 20_000, cleanup: true }))],
    ['mail_domain_health', dependencies.refreshMailHealth ?? (() => refreshMailDomainHealth(env))]
  ];
  for (const [name, run] of tasks) {
    context.waitUntil(Promise.resolve().then(run).catch(() => {
      if (dependencies.onFailure) dependencies.onFailure(name);
      else console.error(JSON.stringify({ level: 'error', event: 'scheduled_task_failed', task: name }));
    }));
  }
}
