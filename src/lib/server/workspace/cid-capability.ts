import { findActiveSessionCapability } from '$lib/server/db/sessions';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

const CAPABILITY_VERSION = 'flaremail-cid-v1';
const CAPABILITY_LIFETIME_MS = 5 * 60 * 1000;
const MAX_ACCEPTED_LIFETIME_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function fromBase64Url(value: string): ArrayBuffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return copyBuffer(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function payload(sessionId: string, routeMessageId: string, attachmentId: string, expires: number): ArrayBuffer {
  return copyBuffer(encoder.encode([CAPABILITY_VERSION, sessionId, routeMessageId, attachmentId, String(expires)].join('\n')));
}

async function hmacKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey('raw', copyBuffer(encoder.encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

async function sign(secret: string, value: ArrayBuffer): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), value);
  return toBase64Url(signature);
}

export async function createCidAttachmentUrls(
  db: D1Database,
  session: WorkspaceContext,
  routeMessageId: string,
  attachmentIds: string[],
  now = Date.now()
): Promise<Map<string, string>> {
  const active = await findActiveSessionCapability(db, session.id, new Date(now).toISOString());
  if (!active || active.user_id !== session.userId) return new Map();
  const sessionExpiry = Date.parse(active.expires_at);
  const expires = Math.floor(Math.min(now + CAPABILITY_LIFETIME_MS, sessionExpiry) / 1000);
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return new Map();

  const urls = new Map<string, string>();
  for (const attachmentId of attachmentIds) {
    const signature = await sign(active.token_hash, payload(session.id, routeMessageId, attachmentId, expires));
    const query = new URLSearchParams({
      inline: '1',
      cid_session: session.id,
      cid_expires: String(expires),
      cid_signature: signature
    });
    urls.set(
      attachmentId,
      `/api/workspace/messages/${encodeURIComponent(routeMessageId)}/attachments/${encodeURIComponent(attachmentId)}?${query}`
    );
  }
  return urls;
}

export async function authorizeCidAttachment(
  db: D1Database,
  routeMessageId: string,
  attachmentId: string,
  searchParams: URLSearchParams,
  now = Date.now()
): Promise<string | null> {
  if (searchParams.get('inline') !== '1') return null;
  const sessionId = searchParams.get('cid_session') ?? '';
  const expiresText = searchParams.get('cid_expires') ?? '';
  const signature = fromBase64Url(searchParams.get('cid_signature') ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) || !/^\d{10}$/u.test(expiresText) || !signature) return null;
  const expires = Number(expiresText);
  if (expires * 1000 <= now || expires * 1000 > now + MAX_ACCEPTED_LIFETIME_MS) return null;

  const active = await findActiveSessionCapability(db, sessionId, new Date(now).toISOString());
  if (!active) return null;
  const key = await hmacKey(active.token_hash, ['verify']);
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    payload(sessionId, routeMessageId, attachmentId, expires)
  );
  return verified ? active.user_id : null;
}
