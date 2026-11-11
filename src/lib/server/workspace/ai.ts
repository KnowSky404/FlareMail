import { fromInboundMessageId, isInboundMessageId } from '$lib/domain/mail';
import { MAIL_AI_VERSION, type MailAiAnalysis, type MailAiInput } from '$lib/domain/mail/ai';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { readBodyObject } from '$lib/server/body';
import { findBodyObject } from '$lib/server/db/body';
import { claimMailAi, consumeMailAiQuota, finishMailAi, readMailAi, type MailAiKey } from '$lib/server/db/mail-ai';
import { resolveWorkspaceMailAiConfiguration } from '$lib/server/ai/settings';
import { mailAiFingerprint, prepareMailAiInput } from '$lib/server/ai/input';
import { createMailAiProvider, validateMailAiAnalysis, type MailAiProvider } from '$lib/server/ai/provider';
import { categorySenderAddress } from '$lib/domain/mail/categories';
import { ApiError } from '$lib/server/http/api';
import { readWorkspaceMessage } from './reader';
import type { WorkspaceContext } from './shared';

async function readEligibleMessage(env: CloudflareEnv, session: WorkspaceContext, id: string) {
  const message = await readWorkspaceMessage(env, session, id);
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  if (message.folder !== 'inbox' || message.quarantinedAt) throw new ApiError(409, 'AI_MESSAGE_UNSUPPORTED', 'AI is unavailable for this message.');
  const blocked = await env.DB.prepare('SELECT 1 FROM blocked_senders WHERE owner_user_id = ? AND email = ?')
    .bind(session.userId, categorySenderAddress(message.fromEmail)).first();
  if (blocked) throw new ApiError(409, 'AI_MESSAGE_UNSUPPORTED', 'AI is unavailable for blocked messages.');
  return message;
}

async function loadInput(env: CloudflareEnv, session: WorkspaceContext, id: string, language: MailAiInput['language'], limit: number) {
  const message = await readEligibleMessage(env, session, id);
  const key: MailAiKey = { owner: session.userId, kind: isInboundMessageId(id) ? 'inbound' : 'workspace', id: isInboundMessageId(id) ? fromInboundMessageId(id) : id };
  const row = key.kind === 'inbound'
    ? await env.DB.prepare('SELECT text_body, html_body, body_object_id FROM email_messages WHERE owner_user_id = ? AND id = ?').bind(key.owner, key.id).first<{ text_body: string; html_body: string; body_object_id: string | null }>()
    : await env.DB.prepare('SELECT COALESCE(NULLIF(text_body, \'\'), body) AS text_body, html_body, body_object_id FROM workspace_messages WHERE user_id = ? AND id = ?').bind(key.owner, key.id).first<{ text_body: string; html_body: string; body_object_id: string | null }>();
  if (!row) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  let text = row.text_body ?? '';
  let html = row.html_body ?? '';
  let bodyFingerprint: string | null = null;
  if (row.body_object_id) {
    const object = await findBodyObject(env.DB, row.body_object_id, key.owner, key.kind === 'inbound' ? 'email_message' : 'workspace_message', key.id);
    if (!object || !env.BUCKET) throw new ApiError(503, 'AI_BODY_UNAVAILABLE', 'Email body is unavailable.');
    try {
      const body = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256);
      text = body.textBody; html = body.htmlBody;
      bodyFingerprint = object.sha256;
    } catch { throw new ApiError(409, 'AI_BODY_UNAVAILABLE', 'Email body integrity check failed.'); }
  }
  const input = prepareMailAiInput(message.subject, message.fromEmail, text, html, language, limit);
  // Include the full canonical body in the cache identity, including the omitted tail.
  const contentHash = await mailAiFingerprint({ ...input, body: bodyFingerprint ?? JSON.stringify([text, html]) }, '', '', MAIL_AI_VERSION);
  return { key, input, contentHash };
}

export async function workspaceMailAi(
  env: CloudflareEnv, session: WorkspaceContext, id: string,
  options: { language: MailAiInput['language']; analyze?: boolean; regenerate?: boolean },
  provider?: MailAiProvider
) {
  if (session.storage !== 'd1') throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', 'Workspace storage unavailable.');
  const configuration = await resolveWorkspaceMailAiConfiguration(env, session.userId);
  if (!configuration.config) {
    await readEligibleMessage(env, session, id);
    return { status: configuration.status, analysis: null };
  }
  const loaded = await loadInput(env, session, id, options.language, configuration.config.maxInputChars);
  const { config } = configuration;
  const { key, input, contentHash } = loaded;
  const fingerprint = await mailAiFingerprint({ ...input, body: JSON.stringify([input.body, contentHash]) }, config.model, `${config.baseUrl}#${config.apiFormat}`, MAIL_AI_VERSION);
  const cached = await readMailAi(env.DB, key);
  if (cached?.fingerprint === fingerprint && cached.status === 'ready' && cached.result_json && !options.regenerate) {
    let analysis: MailAiAnalysis;
    try { analysis = validateMailAiAnalysis(JSON.parse(cached.result_json), input); }
    catch { throw new ApiError(409, 'AI_CACHE_INVALID', 'Saved analysis is invalid. Regenerate it.'); }
    return { status: 'ready', analysis, truncated: input.truncated, updatedAt: cached.updated_at };
  }
  if (!options.analyze) return { status: cached?.status === 'processing' && cached.lease_until > Date.now() ? 'processing' : 'empty', analysis: null };
  if (!input.body.trim()) throw new ApiError(422, 'AI_BODY_EMPTY', 'This message has no readable text.');
  const token = await claimMailAi(env.DB, key, fingerprint, config.model, Boolean(options.regenerate));
  if (!token) throw new ApiError(429, 'AI_BUSY', 'Analysis is busy or cooling down. Retry in a minute.');
  try {
    if (!await consumeMailAiQuota(env.DB, key.owner)) throw new ApiError(429, 'AI_QUOTA_EXCEEDED', 'AI analysis hourly limit reached.');
    const analysis = validateMailAiAnalysis(await (provider ?? createMailAiProvider(config)).analyze(input), input);
    // Recheck visibility and content after the external request, before returning or saving.
    const current = await loadInput(env, session, id, options.language, config.maxInputChars);
    if (current.contentHash !== contentHash) throw new ApiError(409, 'AI_CONTENT_CHANGED', 'The message changed. Please retry.');
    const completed = await finishMailAi(env.DB, key, token, JSON.stringify(analysis));
    if (!completed.meta.changes) throw new ApiError(409, 'AI_CLAIM_LOST', 'Analysis expired. Please retry.');
    return { status: 'ready', analysis, truncated: input.truncated, updatedAt: Date.now() };
  } catch (error) {
    await finishMailAi(env.DB, key, token, null);
    throw error;
  }
}
