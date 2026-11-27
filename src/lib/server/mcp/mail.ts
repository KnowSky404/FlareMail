import { base64url } from 'jose';
import type { MailMessage, UserProfile } from '$lib/domain/mail';
import { fromInboundMessageId, isInboundMessageId, parseAddressJson, parseAddressList, parseMessageIds } from '$lib/domain/mail';
import { truncateUtf8 } from '$lib/domain/utf8';
import { ApiError } from '$lib/server/http/api';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { findOwnedInboundMessage, findOwnedInboundState } from '$lib/server/db/inbound';
import { findOwnedWorkspaceMessage } from '$lib/server/db/messages';
import { findOwnedDraft } from '$lib/server/db/drafts';
import { findDeliveryStatus } from '$lib/server/db/deliveries';
import { getMailboxMetrics, listDraftPage, listWorkspaceMessagePage, mapPageDeliveryStatus, type MailboxRepositoryQuery } from '$lib/server/db/mailbox';
import { findBodyObject } from '$lib/server/db/body';
import { listAttachmentsForEntity } from '$lib/server/db/attachments';
import { attachMailLabels } from '$lib/server/db/labels';
import { mailboxIdentityFilterExists } from '$lib/server/db/mail-identities';
import { readBodyObject } from '$lib/server/body';
import { sanitizeHtml } from '$lib/server/mail/html-sanitize';
import { listInboundMessageSummaryPage } from '$lib/server/workspace/mailbox';
import { parseIdentityFilter, parseMailboxQuery } from '$lib/server/workspace/mailbox-query';
import { mapDraftRow, mapInboundRow, mapWorkspaceMessageRow, type WorkspaceInboundRow } from '$lib/server/workspace/shared';
import { credentialDigest } from './store';

export interface MailActor {
  owner: string;
  profile: UserProfile;
}

export interface SearchInput {
  query?: string;
  folder?: 'all' | 'inbox' | 'sent' | 'archive' | 'drafts';
  identity?: string;
  envelopeRecipient?: string;
  category?: string;
  limit?: number;
  cursor?: string;
}

const bodyBytes = 24 * 1024;
const maxBodyObjectBytes = 512 * 1024;

export const invalidSearch = () => new ApiError(400, 'INVALID_SEARCH_QUERY', 'Invalid or incompatible mail search filters.');
export const missingMessage = () => new ApiError(404, 'MESSAGE_NOT_FOUND', 'Mail message not found.');

export async function mailIdentity(db: D1Database, owner: string, input?: string) {
  const identity = parseIdentityFilter(input ?? null);
  if (identity && !(await mailboxIdentityFilterExists(db, owner, identity))) {
    throw new ApiError(404, 'MAIL_IDENTITY_NOT_FOUND', 'Mail identity not found.');
  }
  return identity;
}

function inboundSummary(row: WorkspaceInboundRow, profile: UserProfile): MailMessage {
  const cc = parseAddressJson(row.cc_json);
  return { ...mapInboundRow(row, profile), toAddresses: parseAddressJson(row.to_json),
    ccAddresses: cc.length ? cc : parseAddressList(row.cc ?? '') };
}

function newestFirst(a: MailMessage, b: MailMessage) {
  const left = a.sentAt + '\0' + a.id;
  const right = b.sentAt + '\0' + b.id;
  return left < right ? 1 : left > right ? -1 : 0;
}

async function scopedRows(env: CloudflareEnv, actor: MailActor, common: Omit<MailboxRepositoryQuery, 'folder'>,
  folders: Array<'inbox' | 'archive' | 'sent' | 'drafts'>, envelopeRecipient?: string) {
  const groups = await Promise.all(folders.flatMap((section) => {
    if (section === 'drafts') {
      return [listDraftPage(env.DB, actor.owner, { ...common, folder: 'drafts', section })
        .then(({ results }) => results.map((row) => mapDraftRow(row, actor.profile)))];
    }
    const sources: Array<Promise<MailMessage[]>> = [];
    if (!envelopeRecipient) sources.push(listWorkspaceMessagePage(env.DB, actor.owner, {
      ...common, folder: section === 'archive' ? 'inbox' : section, section
    }).then(({ results }) => results.map((row) => mapWorkspaceMessageRow(row, mapPageDeliveryStatus(row)))));
    if (section !== 'sent') sources.push(listInboundMessageSummaryPage(env.DB, actor.owner, {
      ...common, section, envelopeRecipient, includeMimeRecipients: true, identityFilter: common.identityFilter
    }).then(({ results }) => results.map((row) => inboundSummary(row, actor.profile))));
    return sources;
  }));
  return [...new Map(groups.flat().map((message) => [message.id, message])).values()].sort(newestFirst);
}

export async function searchMail(env: CloudflareEnv, actor: MailActor, input: SearchInput, threadKey?: string) {
  const { cursor, category, identity, query = '', folder = 'all', limit = 20 } = input;
  const envelopeRecipient = input.envelopeRecipient?.trim();
  const parsed = parseMailboxQuery(new URLSearchParams({ query }));
  const filters = parsed.search?.filters;
  const archivedOnly = filters?.is.includes('archived');
  if (filters?.is.includes('trash') ||
      (archivedOnly && !['all', 'archive'].includes(folder)) ||
      (category && !['all', 'inbox', 'archive'].includes(folder)) ||
      ((filters?.status.length ?? 0) > 0 && (category || envelopeRecipient || !['all', 'sent', 'drafts'].includes(folder))) ||
      (envelopeRecipient && !['all', 'inbox', 'archive'].includes(folder))) throw invalidSearch();

  const identityFilter = await mailIdentity(env.DB, actor.owner, identity);
  const context = await credentialDigest(JSON.stringify([actor.owner, query, folder, identity, category, envelopeRecipient, threadKey]));
  let timestamp: string | undefined;
  let cursorId: string | undefined;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(base64url.decode(cursor)));
      if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== context ||
          typeof parsed[1] !== 'string' || parsed[1].length > 64 || !/^\d{4}-\d{2}-\d{2}[T ]/u.test(parsed[1]) ||
          !Number.isFinite(Date.parse(parsed[1])) ||
          typeof parsed[2] !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/u.test(parsed[2])) throw invalidSearch();
      [, timestamp, cursorId] = parsed as [string, string, string];
    } catch {
      throw new ApiError(400, 'INVALID_CURSOR', 'The cursor does not match this search.');
    }
  }
  const folders: Array<'inbox' | 'archive' | 'sent' | 'drafts'> = folder !== 'all' ? [folder]
    : archivedOnly ? ['archive']
    : filters?.status.length ? ['sent']
    : category || envelopeRecipient ? ['inbox', 'archive'] : ['inbox', 'archive', 'sent'];
  const scanLimit = threadKey ? 3 * (limit + 1) : limit + 1;
  const messages = await scopedRows(env, actor, {
    timestamp, cursorId, limit: scanLimit, includeSearchTotal: false,
    category: category as MailboxRepositoryQuery['category'], identityFilter,
    query: parsed.query, search: parsed.search, filter: 'all', deliveryStatus: null,
    threadKeys: threadKey ? [threadKey, `rfc:<${threadKey.slice(4)}>`] : undefined
  }, folders, envelopeRecipient);
  const scanned = messages.slice(0, scanLimit - 1);
  const verified = threadKey ? scanned.filter((message) => rfcThreadKey(message) === threadKey) : scanned;
  const page = verified.slice(0, limit);
  await attachMailLabels(env.DB, actor.owner, page);
  const last = verified.length > limit ? page.at(-1) : messages.length >= scanLimit ? scanned.at(-1) : undefined;
  return {
    messages: page,
    nextCursor: last ? base64url.encode(JSON.stringify([context, last.sentAt, last.id])) : null
  };
}

export async function getMcpMessage(env: CloudflareEnv, actor: MailActor, id: string, options: {
  includeDraft?: boolean;
  readBody?: boolean;
  attachmentPage?: { afterId: string; limit: number };
  signal: AbortSignal;
}) {
  const inbound = isInboundMessageId(id);
  const entityId = inbound ? fromInboundMessageId(id) : id;
  let message: MailMessage;
  let bodyPointer: string | null | undefined;
  let text = '';
  let html = '';
  if (inbound) {
    const state = await findOwnedInboundState(env.DB, actor.owner, entityId, { includeBody: false });
    if (!state || state.quarantined_at) throw missingMessage();
    const row = await findOwnedInboundMessage(env.DB, actor.owner, entityId, { includeBody: options.readBody !== false });
    if (!row) throw missingMessage();
    message = inboundSummary({ ...state, to_json: row.to_json, cc_json: row.cc_json, cc: row.cc }, actor.profile);
    bodyPointer = row.body_object_id;
    text = row.text_body;
    html = row.html_body;
  } else {
    const row = await findOwnedWorkspaceMessage(env.DB, actor.owner, id, { includeBody: options.readBody !== false, includeHtml: options.readBody !== false });
    if (row) {
      if (row.deleted_at || !['inbox', 'sent'].includes(row.folder)) throw missingMessage();
      const delivery = row.folder === 'sent' ? await findDeliveryStatus(env.DB, actor.owner, id) : null;
      message = mapWorkspaceMessageRow(row, delivery ?? undefined);
      bodyPointer = row.body_object_id;
      text = row.body;
      html = row.html_body ?? '';
    } else {
      const draft = options.includeDraft ? await findOwnedDraft(env.DB, actor.owner, id, { activeOnly: true }) : null;
      if (!draft) throw missingMessage();
      message = mapDraftRow(draft, actor.profile);
      bodyPointer = draft.body_object_id;
      text = draft.body;
    }
  }
  const type = inbound ? 'inbound' : message.folder === 'drafts' ? 'draft' : 'message';
  const attachments = await listAttachmentsForEntity(env.DB, actor.owner, type, entityId, options.attachmentPage ?? { limit: 1 });
  message.hasAttachments = attachments.some((attachment) => attachment.state === 'ready');
  await attachMailLabels(env.DB, actor.owner, [message]);
  if (options.readBody === false) return { message, body: '', truncated: false, attachments };
  options.signal.throwIfAborted();
  let partial = false;
  if (bodyPointer) {
    const object = await findBodyObject(env.DB, bodyPointer, actor.owner,
      inbound ? 'email_message' : type === 'draft' ? 'draft' : 'workspace_message', entityId);
    if (!object) throw new ApiError(503, 'BODY_OBJECT_NOT_FOUND', 'Mail body temporarily unavailable.');
    if (object.size_bytes <= maxBodyObjectBytes) {
      const canonical = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256);
      text = canonical.textBody;
      html = canonical.htmlBody;
    } else {
      partial = true;
    }
  }
  options.signal.throwIfAborted();
  if (!text.trim() && html) {
    const input = truncateUtf8(html, 64 * 1024);
    partial ||= input !== html;
    text = sanitizeHtml(input).text;
  }
  const body = truncateUtf8(text, bodyBytes);
  return { message, body, truncated: partial || body !== text, attachments };
}

export function rfcThreadKey(message: MailMessage) {
  const rfc = parseMessageIds(message.references)[0] ?? parseMessageIds(message.inReplyTo)[0] ?? parseMessageIds(message.messageId)[0];
  if (!rfc || !message.threadKey?.startsWith('rfc:')) return null;
  return parseMessageIds(message.threadKey.slice(4))[0] === rfc ? `rfc:${rfc}` : null;
}

export async function getMcpMetrics(env: CloudflareEnv, actor: MailActor, identity?: string) {
  return getMailboxMetrics(env.DB, actor.owner, await mailIdentity(env.DB, actor.owner, identity), { includeDraftStars: false });
}
