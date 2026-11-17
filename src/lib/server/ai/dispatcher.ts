import { toInboundMessageId } from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { findUserById } from '$lib/server/db/users';
import { claimMailAiJob, isMailAiJobAuthorized, reserveMailAiJobAttempt, applyMailAiJobCategory, finishMailAiJob } from '$lib/server/db/mail-ai-jobs';
import { ApiError } from '$lib/server/http/api';
import { workspaceMailAi } from '$lib/server/workspace/ai';
import { mapUserRowToProfile, type WorkspaceContext } from '$lib/server/workspace/shared';
import type { MailAiProvider } from './provider';

/** Durable classification is independent of Telegram and never holds up mail persistence. */
export async function dispatchMailAiJobs(env: CloudflareEnv, options: { provider?: MailAiProvider; limit?: number; timeBudgetMs?: number } = {}) {
  const result = { processed: 0, classified: 0 };
  if (!env.DB) return result;
  const deadline = Date.now() + Math.max(1, Math.min(options.timeBudgetMs ?? 20_000, 25_000));
  while (result.processed < Math.max(1, Math.min(options.limit ?? 5, 20)) && deadline - Date.now() > 100) {
    const job = await claimMailAiJob(env.DB);
    if (!job) break;
    result.processed++;
    try {
      const user = await findUserById(env.DB, job.owner_user_id);
      if (!user || !await isMailAiJobAuthorized(env.DB, job)) {
        await finishMailAiJob(env.DB, job, 'cancelled'); continue;
      }
      const session: WorkspaceContext = { id: '', userId: user.id, storage: 'd1', profile: mapUserRowToProfile(user),
        incomingSequence: user.incoming_sequence, createdAt: '', updatedAt: '' };
      const id = toInboundMessageId(job.message_id);
      let view = await workspaceMailAi(env, session, id, {});
      if (view.status !== 'ready') {
        if (view.status === 'processing') {
          await finishMailAiJob(env.DB, job, 'pending', Date.now() + 60_000); continue;
        }
        if (job.attempted || view.status === 'disabled' || view.status === 'unconfigured') {
          await finishMailAiJob(env.DB, job, 'failed'); continue;
        }
        view = await workspaceMailAi(env, session, id, { analyze: true, timeoutMs: Math.max(1, deadline - Date.now()),
          beforeAnalyze: () => reserveMailAiJobAttempt(env.DB, job) }, options.provider);
      }
      if (view.analysis?.suggestion) {
        const applied = await applyMailAiJobCategory(env.DB, job, view.analysis.suggestion.category);
        if (applied.meta.changes) result.classified++;
      }
      await finishMailAiJob(env.DB, job, 'done');
    } catch (error) {
      const unattempted = await env.DB.prepare('SELECT attempted FROM mail_ai_jobs WHERE owner_user_id = ? AND message_id = ? AND claim_token = ?')
        .bind(job.owner_user_id, job.message_id, job.claim_token).first<{ attempted: number }>();
      const beforeRequest = error instanceof ApiError && error.code === 'AI_TIMEOUT' && error.details?.reason === 'before_provider_request';
      const defer = beforeRequest || (!unattempted?.attempted && error instanceof ApiError && ['AI_BUSY', 'AI_QUOTA_EXCEEDED', 'AI_TIMEOUT'].includes(error.code));
      await finishMailAiJob(env.DB, job, defer ? 'pending' : 'failed', defer ? Date.now() + (error instanceof ApiError && error.code === 'AI_QUOTA_EXCEEDED' ? 3_600_000 : 60_000) : 0, beforeRequest);
    }
  }
  return result;
}
