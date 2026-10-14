import { ApiError } from '$lib/server/http/api';

type ListCursor = { version: 1; scope: 'trash' | 'telegram'; owner: string; timestamp: string; id: string; kind?: 'workspace' | 'draft' | 'inbound' };

export function encodeListCursor(cursor: Omit<ListCursor, 'version'>) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, ...cursor }));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeListCursor(value: string | null, scope: ListCursor['scope'], owner: string): ListCursor | null {
  if (value === null) return null;
  try {
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)))) as ListCursor;
    if (cursor.version !== 1 || cursor.scope !== scope || cursor.owner !== owner ||
      typeof cursor.timestamp !== 'string' || !Number.isFinite(Date.parse(cursor.timestamp)) ||
      typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 256 ||
      (scope === 'trash' && !['workspace', 'draft', 'inbound'].includes(cursor.kind ?? ''))) throw new Error();
    return cursor;
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效，请从第一页重新读取。', undefined, undefined, false);
  }
}
