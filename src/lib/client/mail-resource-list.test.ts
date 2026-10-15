import { describe, expect, test } from 'bun:test';
import { filterMailAddresses, filterMailDomains, paginateMailResources, type ResourceLifecycle } from './mail-resource-list';

type Address = {
  id: string;
  email: string;
  display_name: string;
  domain_id: string;
  lifecycle_status: ResourceLifecycle;
};

const addresses: Address[] = [
  { id: 'a1', email: 'alpha@example.com', display_name: 'Alpha', domain_id: 'd1', lifecycle_status: 'active' },
  { id: 'a2', email: 'beta@example.com', display_name: 'Beta', domain_id: 'd2', lifecycle_status: 'disabled' },
  { id: 'a3', email: 'alpha-team@example.net', display_name: 'Alpha team', domain_id: 'd1', lifecycle_status: 'deleted' },
  { id: 'a4', email: 'gamma@example.com', display_name: 'Gamma', domain_id: 'd1', lifecycle_status: 'active' }
];

describe('mail resource list helpers', () => {
  test('defaults to ten rows and retains the complete total on later pages', () => {
    const items = Array.from({ length: 21 }, (_, index) => index);

    expect(paginateMailResources(items)).toMatchObject({
      items: items.slice(0, 10), total: 21, page: 1, pageCount: 3, pageSize: 10
    });
    expect(paginateMailResources(items, 3)).toMatchObject({
      items: [20], total: 21, page: 3, pageCount: 3, pageSize: 10
    });
  });

  test('falls back to ten rows for invalid page sizes', () => {
    const items = Array.from({ length: 21 }, (_, index) => index);

    for (const pageSize of [0, -1, 0.5, NaN, Infinity]) {
      expect(paginateMailResources(items, 1, pageSize)).toMatchObject({
        items: items.slice(0, 10), pageSize: 10, pageCount: 3
      });
    }
  });

  test('uses the selected page size and clamps the page after increasing it', () => {
    const items = Array.from({ length: 31 }, (_, index) => index);

    expect(paginateMailResources(items, 2, 20)).toMatchObject({
      items: items.slice(20), total: 31, page: 2, pageCount: 2, pageSize: 20
    });
    expect(paginateMailResources(items, 4, 50)).toMatchObject({
      items, total: 31, page: 1, pageCount: 1, pageSize: 50
    });
  });

  test('filters the complete address collection before pagination', () => {
    const matching = filterMailAddresses(addresses, { search: 'alpha', domainId: 'd1' });
    const page = paginateMailResources(matching, 1, 1);

    expect(matching.map((address) => address.id)).toEqual(['a1']);
    expect(page).toMatchObject({ total: 1, page: 1, pageCount: 1, pageSize: 1 });
    expect(page.items.map((address) => address.id)).toEqual(['a1']);
  });

  test('includes disabled addresses in current scope and only shows deleted explicitly', () => {
    const current = filterMailAddresses(addresses);
    const deleted = filterMailAddresses(addresses, { lifecycle: 'deleted' });

    expect(current.map((address) => address.id)).toEqual(['a1', 'a2', 'a4']);
    expect(current.some((address) => address.lifecycle_status === 'disabled')).toBe(true);
    expect(deleted.map((address) => address.id)).toEqual(['a3']);
  });

  test('filters domains by search and status before pagination', () => {
    const matching = filterMailDomains([
      { domain_name: 'example.com', enabled: 1 },
      { domain_name: 'example.net', enabled: 0 },
      { domain_name: 'other.test', enabled: 1 }
    ], 'EXAMPLE', 'enabled');
    const page = paginateMailResources(matching, 1, 1);

    expect(matching.map((domain) => domain.domain_name)).toEqual(['example.com']);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([{ domain_name: 'example.com', enabled: 1 }]);
  });

  test('clamps an out-of-range page while retaining the complete matching total', () => {
    const matching = filterMailAddresses(addresses, { domainId: 'd1', lifecycle: 'all' });
    const page = paginateMailResources(matching, 99, 2);

    expect(page).toMatchObject({ total: 3, page: 2, pageCount: 2, pageSize: 2 });
    expect(page.items.map((address) => address.id)).toEqual(['a4']);
  });
});
