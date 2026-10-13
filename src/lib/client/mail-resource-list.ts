/**
 * Shared, deterministic filters and pagination for management resource tables.
 *
 * The management API returns the complete configured collection. Apply filters
 * to that collection, sort the matching rows, then paginate them.
 */

export type ResourceLifecycle = 'active' | 'disabled' | 'deleted';

export type MailDomainStatusFilter = 'all' | 'enabled' | 'disabled';
export type MailAddressLifecycleFilter = 'all' | 'current' | ResourceLifecycle;

export type MailDomainListItem = {
  domain_name: string;
  enabled: number | boolean;
};

export type MailAddressListItem = {
  email: string;
  display_name: string;
  domain_id: string;
  lifecycle_status: ResourceLifecycle;
};

export type MailResourcePage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

function normalizeQuery(query: string | undefined) {
  return query?.trim().toLocaleLowerCase() ?? '';
}

function normalizePageSize(pageSize: number | undefined) {
  return Number.isFinite(pageSize) && pageSize && pageSize > 0 ? Math.floor(pageSize) : 25;
}

function normalizePage(page: number | undefined) {
  return Number.isFinite(page) && page && page > 0 ? Math.floor(page) : 1;
}

/** Filter configured domains without treating a visible provider zone as a managed resource. */
export function filterMailDomains<T extends MailDomainListItem>(
  domains: readonly T[],
  search = '',
  status: MailDomainStatusFilter = 'all'
) {
  const normalizedSearch = normalizeQuery(search);
  return domains.filter((domain) => {
    if (normalizedSearch && !domain.domain_name.toLocaleLowerCase().includes(normalizedSearch)) return false;
    if (status === 'enabled' && !Boolean(domain.enabled)) return false;
    if (status === 'disabled' && Boolean(domain.enabled)) return false;
    return true;
  });
}

/** Filter the complete address collection; current is the default non-deleted scope. */
export function filterMailAddresses<T extends MailAddressListItem>(
  addresses: readonly T[],
  options: { search?: string; domainId?: string | null; lifecycle?: MailAddressLifecycleFilter } = {}
) {
  const normalizedSearch = normalizeQuery(options.search);
  const lifecycle = options.lifecycle ?? 'current';
  return addresses.filter((address) => {
    if (normalizedSearch) {
      const searchable = `${address.email} ${address.display_name}`.toLocaleLowerCase();
      if (!searchable.includes(normalizedSearch)) return false;
    }
    if (options.domainId && address.domain_id !== options.domainId) return false;
    if (lifecycle === 'current' && address.lifecycle_status === 'deleted') return false;
    if (lifecycle !== 'all' && lifecycle !== 'current' && address.lifecycle_status !== lifecycle) return false;
    return true;
  });
}

/** Paginate after all list filters and sorting have been applied. */
export function paginateMailResources<T>(items: readonly T[], page = 1, pageSize = 25): MailResourcePage<T> {
  const normalizedPageSize = normalizePageSize(pageSize);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / normalizedPageSize));
  const normalizedPage = Math.min(normalizePage(page), pageCount);
  const start = (normalizedPage - 1) * normalizedPageSize;
  return {
    items: items.slice(start, start + normalizedPageSize),
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    pageCount
  };
}
