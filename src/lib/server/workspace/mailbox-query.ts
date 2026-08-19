import type {
  DeliveryStatus,
  MailFolder,
  MailboxFilter,
  MailboxSection,
  MailSearchQuery
} from '$lib/domain/mail';
import { parseMailSearchQuery, SearchQueryParseError } from '$lib/domain/mail';
import { boundedUtf8 } from '$lib/domain/utf8';
import { ApiError } from '$lib/server/http/api';

export const defaultMailboxPageSize = 40;
export const maxMailboxPageSize = 100;
/** D1's maximum LIKE/GLOB pattern size, including both wildcard markers. */
export const maxD1LikePatternBytes = 50;

const folders = new Set<MailFolder>(['inbox', 'sent', 'drafts']);
const filters = new Set<MailboxFilter>(['all', 'unread', 'starred']);
const deliveryStatuses = new Set<DeliveryStatus>([
  'draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed',
  'bounced', 'failed', 'complained', 'suppressed'
]);

/** Build the only LIKE pattern accepted by the pre-FTS fallback. */
export function buildD1LikeSearchPattern(query: string): string {
  const pattern = `%${query.toLocaleLowerCase()}%`;
  if (!boundedUtf8(pattern, maxD1LikePatternBytes).ok) {
    throw new ApiError(
      400,
      'QUERY_PATTERN_TOO_LARGE',
      '搜索内容的 UTF-8 字节数超过当前搜索限制。',
      { query: [`当前搜索最多支持 ${maxD1LikePatternBytes - 2} 个 UTF-8 字节。`] }
    );
  }
  return pattern;
}

export interface MailboxCursor {
  version: 1;
  folder: MailFolder;
  section?: MailboxSection;
  timestamp: string;
  id: string;
}

export interface MailboxQuery {
  folder: MailFolder;
  section?: MailboxSection;
  cursor: MailboxCursor | null;
  limit: number;
  query: string;
  search: MailSearchQuery | null;
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

export function decodeMailboxCursor(value: string, folder: MailFolder, section: MailboxSection = folder): MailboxCursor {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as Partial<MailboxCursor>;
    if (
      parsed.version !== 1 ||
      parsed.folder !== folder ||
      (parsed.section !== undefined && parsed.section !== section) ||
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
  const sectionValue = params.get('section') ?? folderValue;
  if (folderValue !== 'archive' && !folders.has(folderValue as MailFolder)) {
    throw new ApiError(400, 'INVALID_FOLDER', '邮件文件夹无效。', {
      folder: ['仅支持 inbox、sent 或 drafts。']
    });
  }
  const section = sectionValue as MailboxSection;
  if (!['inbox', 'sent', 'drafts', 'archive'].includes(section)) {
    throw new ApiError(400, 'INVALID_SECTION', '邮件分区无效。');
  }
  const folder = section === 'archive' ? 'inbox' : folderValue as MailFolder;
  if (section === 'archive' && folderValue !== 'archive' && folderValue !== 'inbox') {
    throw new ApiError(400, 'INVALID_SECTION', '归档分区必须使用 inbox 或 archive 查询。');
  }

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
  let search: MailSearchQuery | null = null;
  if (query) {
    try {
      search = parseMailSearchQuery(query);
    } catch (error) {
      if (!(error instanceof SearchQueryParseError)) throw error;
      const messages: Record<SearchQueryParseError['code'], string> = {
        input_too_large: '搜索表达式过长。',
        too_many_tokens: '搜索条件过多。',
        malformed_quotes: '搜索表达式中的引号不完整。',
        unknown_operator: '搜索表达式包含不支持的操作符。',
        missing_value: '搜索操作符缺少值。',
        invalid_value: '搜索操作符的值无效。',
        invalid_date: '日期必须使用 YYYY-MM-DD 格式。',
        invalid_status: '投递状态无效。'
      };
      throw new ApiError(400, 'INVALID_SEARCH_QUERY', messages[error.code], {
        query: [messages[error.code]]
      });
    }
  }

  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? defaultMailboxPageSize : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxMailboxPageSize) {
    throw new ApiError(400, 'INVALID_LIMIT', `分页大小必须是 1 到 ${maxMailboxPageSize} 的整数。`, {
      limit: [`请输入 1 到 ${maxMailboxPageSize}。`]
    });
  }

  const statusValue = params.get('status');
  if (statusValue && (section !== 'sent' || !deliveryStatuses.has(statusValue as DeliveryStatus))) {
    throw new ApiError(400, 'INVALID_DELIVERY_STATUS', '投递状态筛选无效。', {
      status: ['投递状态仅适用于已发送邮件。']
    });
  }

  const cursorValue = params.get('cursor');
  return {
    folder,
    cursor: cursorValue ? decodeMailboxCursor(cursorValue, folder, section) : null,
    section,
    limit,
    query,
    search,
    filter: filterValue as MailboxFilter,
    deliveryStatus: statusValue as DeliveryStatus | null
  };
}
