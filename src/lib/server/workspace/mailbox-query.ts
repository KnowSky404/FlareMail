import type {
  DeliveryStatus,
  MailFolder,
  MailboxFilter
} from '$lib/domain/mail';
import { ApiError } from '$lib/server/http/api';

export const defaultMailboxPageSize = 40;
export const maxMailboxPageSize = 100;

const folders = new Set<MailFolder>(['inbox', 'sent', 'drafts']);
const filters = new Set<MailboxFilter>(['all', 'unread', 'starred']);
const deliveryStatuses = new Set<DeliveryStatus>([
  'draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed',
  'bounced', 'failed', 'complained', 'suppressed'
]);

export interface MailboxCursor {
  version: 1;
  folder: MailFolder;
  timestamp: string;
  id: string;
}

export interface MailboxQuery {
  folder: MailFolder;
  cursor: MailboxCursor | null;
  limit: number;
  query: string;
  filter: MailboxFilter;
  deliveryStatus: DeliveryStatus | null;
}

const isIsoTimestamp = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

export function encodeMailboxCursor(cursor: Omit<MailboxCursor, 'version'>): string {
  return btoa(JSON.stringify({ version: 1, ...cursor }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeMailboxCursor(value: string, folder: MailFolder): MailboxCursor {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as Partial<MailboxCursor>;
    if (
      parsed.version !== 1 ||
      parsed.folder !== folder ||
      typeof parsed.timestamp !== 'string' ||
      !isIsoTimestamp(parsed.timestamp) ||
      typeof parsed.id !== 'string' ||
      !/^[A-Za-z0-9:._-]{1,256}$/u.test(parsed.id)
    ) throw new Error('invalid cursor');
    return parsed as MailboxCursor;
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效或与当前文件夹不匹配。', {
      cursor: ['请从上一页响应的 nextCursor 继续分页。']
    });
  }
}

export function parseMailboxQuery(params: URLSearchParams): MailboxQuery {
  const folderValue = params.get('folder') ?? 'inbox';
  if (!folders.has(folderValue as MailFolder)) {
    throw new ApiError(400, 'INVALID_FOLDER', '邮件文件夹无效。', {
      folder: ['仅支持 inbox、sent 或 drafts。']
    });
  }
  const folder = folderValue as MailFolder;

  const filterValue = params.get('filter') ?? 'all';
  if (!filters.has(filterValue as MailboxFilter)) {
    throw new ApiError(400, 'INVALID_FILTER', '邮件筛选条件无效。', {
      filter: ['仅支持 all、unread 或 starred。']
    });
  }

  const query = (params.get('query') ?? params.get('q') ?? '').trim();
  if (query.length > 200) {
    throw new ApiError(400, 'QUERY_TOO_LONG', '搜索内容不能超过 200 个字符。', {
      query: ['最多输入 200 个字符。']
    });
  }

  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? defaultMailboxPageSize : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxMailboxPageSize) {
    throw new ApiError(400, 'INVALID_LIMIT', `分页大小必须是 1 到 ${maxMailboxPageSize} 的整数。`, {
      limit: [`请输入 1 到 ${maxMailboxPageSize}。`]
    });
  }

  const statusValue = params.get('status');
  if (statusValue && (folder !== 'sent' || !deliveryStatuses.has(statusValue as DeliveryStatus))) {
    throw new ApiError(400, 'INVALID_DELIVERY_STATUS', '投递状态筛选无效。', {
      status: ['投递状态仅适用于已发送邮件。']
    });
  }

  const cursorValue = params.get('cursor');
  return {
    folder,
    cursor: cursorValue ? decodeMailboxCursor(cursorValue, folder) : null,
    limit,
    query,
    filter: filterValue as MailboxFilter,
    deliveryStatus: statusValue as DeliveryStatus | null
  };
}
