import { describe, expect, test } from 'bun:test';
import { cloneMailbox, type MailMessage, type MailboxPage, type MailboxState, type WorkspaceMetrics } from '$lib/domain/mail';
import {
  MailboxController,
  createEmptyWorkspaceViewState,
  mailboxSnapshotFromWorkspace,
  mergeMailboxPage,
  mergeMessageDelta,
  moveSelection,
  reconcileBulkSelection,
  removeMessage,
  selectNextMessage,
  workspaceViewStateFromSnapshot
} from './mailbox-controller';

const metrics: WorkspaceMetrics = { inboxCount: 1, archiveCount: 0, sentCount: 0, draftsCount: 0, trashCount: 0, unreadCount: 1, starredCount: 0,
  queuedCount: 0, delayedCount: 0, failedCount: 0, bouncedCount: 0, complainedCount: 0, staleDeliveryCount: 0 };
const message = (id: string, folder: MailMessage['folder'], sentAt: string): MailMessage => ({
  id,
  folder,
  source: folder === 'inbox' ? 'inbound' : 'workspace',
  fromName: 'Sender',
  fromEmail: 'sender@example.com',
  toName: 'Owner',
  toEmail: 'owner@example.com',
  cc: '',
  subject: id,
  preview: id,
  body: id,
  sentAt,
  read: false,
  starred: false,
  messageId: null,
  inReplyTo: null,
  references: null,
  labels: [],
  deliveryStatus: null,
  deliveryProvider: null,
  deliveryAttempts: 0
});

const snapshot = (mailbox: MailboxState) => ({ mailbox, mailboxPages: null, metrics });
const delta = (value: MailMessage) => ({ message: value, metrics, metricsScope: { identityFilter: null } as const });
const deltaOptions = (overrides: Partial<Parameters<typeof mergeMessageDelta>[2]> = {}) => ({
  currentSection: 'inbox' as const,
  currentSelectedMessageId: null,
  identityFilter: null,
  identityAddresses: [],
  query: '',
  filter: 'all' as const,
  ...overrides
});

describe('mailbox controller', () => {
  test('hydrates the partial active-folder snapshot without inventing inactive pages', () => {
    const page = makePage('inbox', [message('inbox', 'inbox', '2026-08-14T02:00:00.000Z')]);
    const hydrated = mailboxSnapshotFromWorkspace({
      profile: {
        name: 'Owner', role: 'Owner', email: 'owner@example.com', company: '', location: '', timezone: 'UTC',
        forwardingEnabled: false, signature: ''
      },
      metrics,
      activeFolder: 'inbox',
      activePage: page,
      mailbox: { inbox: page.messages, sent: [], drafts: [] },
      mailboxPages: { inbox: page },
      mailIdentityOptions: { domains: [], addresses: [] }
    });

    expect(hydrated.mailbox.inbox).toHaveLength(1);
    expect(hydrated.mailbox.sent).toHaveLength(0);
    expect(Object.keys(hydrated.mailboxPages ?? {})).toEqual(['inbox']);
  });

  test('merges pages and keeps the metrics from the first page on load more', () => {
    const first = message('first', 'inbox', '2026-08-14T02:00:00.000Z');
    const second = message('second', 'inbox', '2026-08-14T01:00:00.000Z');
    const initial = mergeMailboxPage(snapshot(cloneMailbox()), {
      folder: 'inbox',
      messages: [first],
      limit: 1,
      nextCursor: 'cursor',
      hasMore: true,
      query: '',
      filter: 'all',
      deliveryStatus: null,
      searchTotal: 2,
      searchHitFields: ['all'],
      metrics
    }, false);
    const next = mergeMailboxPage(initial, {
      folder: 'inbox',
      messages: [second],
      limit: 1,
      nextCursor: null,
      hasMore: false,
      query: '',
      filter: 'all',
      deliveryStatus: null
    }, true);

    expect(next.mailbox.inbox.map((item) => item.id)).toEqual(['first', 'second']);
    expect(next.mailboxPages?.inbox?.messages.map((item) => item.id)).toEqual(['first', 'second']);
    expect(next.mailboxPages?.inbox?.searchTotal).toBe(2);
    expect(next.mailboxPages?.inbox?.searchHitFields).toEqual(['all']);
    expect(next.metrics).toEqual(metrics);
  });

  test('applies the complete login snapshot and clears prior view state', () => {
    const page = makePage('inbox', [message('inbox', 'inbox', '2026-08-14T02:00:00.000Z')]);
    const state = workspaceViewStateFromSnapshot({
      profile: {
        name: 'Owner', role: 'Owner', email: 'owner@example.com', company: '', location: '', timezone: 'UTC',
        forwardingEnabled: false, signature: ''
      },
      metrics: { ...metrics, inboxCount: 45, sentCount: 3, draftsCount: 2 },
      activeFolder: 'inbox',
      activePage: { ...page, hasMore: true, nextCursor: 'next' },
      mailbox: { inbox: page.messages, sent: [], drafts: [] },
      mailboxPages: { inbox: { ...page, hasMore: true, nextCursor: 'next' } },
      mailIdentityOptions: { domains: [], addresses: [] }
    }, { section: 'inbox', preferredMessageId: 'inbox', clearMailView: true });

    expect(state.metrics).toMatchObject({ inboxCount: 45, sentCount: 3, draftsCount: 2 });
    expect(state.mailboxPages?.inbox?.nextCursor).toBe('next');
    expect(state.selectedMessageId).toBe('inbox');
    expect(state.selectedMessageIds).toEqual([]);
    expect(state.searchQuery).toBe('');
    expect(state.mailFilter).toBe('all');
  });

  test('does not select the first page item when a deep-linked target is absent', () => {
    const page = makePage('inbox', [message('first', 'inbox', '2026-08-14T02:00:00.000Z')]);
    const state = workspaceViewStateFromSnapshot({
      profile: {
        name: 'Owner', role: 'Owner', email: 'owner@example.com', company: '', location: '', timezone: 'UTC',
        forwardingEnabled: false, signature: ''
      },
      metrics,
      activeFolder: 'inbox',
      activePage: page,
      mailbox: { inbox: page.messages, sent: [], drafts: [] },
      mailboxPages: { inbox: page },
      mailIdentityOptions: { domains: [], addresses: [] }
    }, { section: 'inbox', preferredMessageId: 'email:older' });

    expect(state.selectedMessageId).toBeNull();
  });

  test('resets every user-scoped view field and reconciles selections on replacement', () => {
    const empty = createEmptyWorkspaceViewState();
    expect(empty).toMatchObject({
      activeSection: 'inbox', selectedMessageId: null, selectedMessageIds: [], searchQuery: '', mailFilter: 'all',
      mailboxPages: null
    });
    const first = message('first', 'inbox', '2026-08-14T02:00:00.000Z');
    const second = message('second', 'inbox', '2026-08-14T01:00:00.000Z');
    expect(reconcileBulkSelection(['first', 'stale', 'first'], [first, second])).toEqual(['first']);
  });

  test('applies a delta without changing unrelated folders and selects the result', () => {
    const inbox = message('inbox', 'inbox', '2026-08-14T02:00:00.000Z');
    const draft = message('draft', 'drafts', '2026-08-14T01:00:00.000Z');
    const result = mergeMessageDelta(
      snapshot({ ...cloneMailbox(), inbox: [inbox], drafts: [draft] }),
      delta({ ...inbox, starred: true }),
      deltaOptions({ currentSelectedMessageId: inbox.id })
    );

    expect(result.snapshot.mailbox.inbox[0]?.starred).toBe(true);
    expect(result.snapshot.mailbox.drafts[0]?.id).toBe('draft');
    expect(result.selectedMessageId).toBe('inbox');
  });

  test('adds a deep-linked archived message to an initially partial archive page', () => {
    const archived = { ...message('email:archived', 'inbox', '2026-08-14T01:00:00.000Z'), archivedAt: '2026-08-14T03:00:00.000Z' };
    const result = mergeMessageDelta(
      snapshot(cloneMailbox()),
      delta(archived),
      deltaOptions({ currentSection: 'archive', section: 'archive', preferredMessageId: archived.id })
    );

    expect(result.snapshot.mailboxPages?.archive?.messages.map((item) => item.id)).toEqual([archived.id]);
    expect(result.selectedMessageId).toBe(archived.id);
  });

  test('drops an out-of-identity delta and its global metrics from the filtered view', () => {
    const baseline = { ...metrics, inboxCount: 99 };
    const before = snapshot(cloneMailbox());
    before.metrics = baseline;
    const foreign = { ...message('foreign', 'inbox', '2026-08-14T01:00:00.000Z'), recipientAddressId: 'address-b' };
    const result = mergeMessageDelta(before, delta(foreign), deltaOptions({
      identityFilter: { kind: 'address', id: 'address-a' },
      identityAddresses: [
        { id: 'address-a', domainId: 'domain-a' },
        { id: 'address-b', domainId: 'domain-b' }
      ]
    }));

    expect(result.snapshot.mailbox.inbox).toEqual([]);
    expect(result.snapshot.metrics).toEqual(baseline);
    expect(result.messageApplied).toBe(false);
    expect(result.metricsApplied).toBe(false);
  });

  test('does not insert a new message into an active search or state-filtered page', () => {
    const newMessage = message('new', 'inbox', '2026-08-14T01:00:00.000Z');
    const result = mergeMessageDelta(snapshot(cloneMailbox()), delta(newMessage), deltaOptions({ query: 'invoice' }));

    expect(result.snapshot.mailbox.inbox).toEqual([]);
    expect(result.snapshot.metrics).toEqual(metrics);
    expect(result.messageApplied).toBe(false);
  });

  test('removes a changed message from a page when it no longer matches its unread filter', () => {
    const unread = message('unread', 'inbox', '2026-08-14T01:00:00.000Z');
    const before = {
      mailbox: { ...cloneMailbox(), inbox: [unread] },
      mailboxPages: { inbox: { ...makePage('inbox', [unread]), filter: 'unread' as const } },
      metrics
    };
    const result = mergeMessageDelta(before, delta({ ...unread, read: true }), deltaOptions({ filter: 'unread' }));

    expect(result.snapshot.mailbox.inbox).toEqual([]);
    expect(result.snapshot.mailboxPages?.inbox?.messages).toEqual([]);
    expect(result.messageApplied).toBe(false);
  });

  test('removes only the targeted folder entry and moves selection safely', () => {
    const first = message('first', 'drafts', '2026-08-14T02:00:00.000Z');
    const second = message('second', 'drafts', '2026-08-14T01:00:00.000Z');
    const result = removeMessage(snapshot({ ...cloneMailbox(), drafts: [first, second] }), 'first', 'drafts', 'drafts', 'first');

    expect(result.snapshot.mailbox.drafts.map((item) => item.id)).toEqual(['second']);
    expect(result.selectedMessageId).toBe('second');
  });

  test('provides deterministic selection movement', () => {
    const first = message('first', 'drafts', '2026-08-14T02:00:00.000Z');
    const second = message('second', 'drafts', '2026-08-14T01:00:00.000Z');
    expect(selectNextMessage({ ...cloneMailbox(), drafts: [first, second] }, 'drafts', null)).toBe('first');
    expect(moveSelection([first, second], 'first', 1)?.id).toBe('second');
  });

  test('owns mailbox query construction and reports a successful refresh', async () => {
    const seen: { value: URLSearchParams | null } = { value: null };
    const pages: Array<{ page: MailboxPage; append: boolean }> = [];
    const controller = new MailboxController(async (params) => {
      seen.value = params;
      return { page: makePage('inbox', []) };
    }, {
      onPage: (page, append) => pages.push({ page, append }),
      onLoading: () => undefined,
      onError: () => undefined
    });

    expect(await controller.refresh('inbox', ' invoice ', 'starred')).toBe(true);
    expect(seen.value?.toString()).toContain('folder=inbox');
    expect(seen.value?.toString()).toContain('q=invoice');
    expect(seen.value?.toString()).toContain('filter=starred');
    expect(pages[0]?.append).toBe(false);
  });

  test('reports refresh and append loading separately and clears a cancelled append', async () => {
    const loading: Array<{ loading: boolean; append: boolean }> = [];
    const errors: string[] = [];
    const page = { ...makePage('inbox', []), nextCursor: 'next', hasMore: true };
    const controller = new MailboxController(async (params, signal) => {
      if (!params.has('cursor')) return { page };
      return new Promise<{ page: MailboxPage }>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }, {
      onPage: () => undefined,
      onLoading: (isLoading, append) => loading.push({ loading: isLoading, append }),
      onError: (error) => errors.push(error)
    });

    expect(await controller.refresh('inbox', '', 'all')).toBe(true);
    const pendingAppend = controller.loadMore('inbox', '', 'all', page);
    expect(loading).toEqual([
      { loading: true, append: false }, { loading: false, append: false },
      { loading: true, append: true }
    ]);
    controller.cancel();
    expect(await pendingAppend).toBe(false);
    expect(loading.at(-1)).toEqual({ loading: false, append: true });
    expect(errors).toEqual([]);
  });
});

function makePage(folder: MailboxPage['folder'], messages: MailMessage[]) {
  return {
    folder,
    messages,
    nextCursor: null,
    hasMore: false,
    limit: 40,
    query: '',
    filter: 'all' as const,
    identityFilter: null,
    deliveryStatus: null
  };
}

test('category scopes refresh and pagination and ignores stale tab responses', async () => {
  const calls: Array<URLSearchParams> = [];
  const applied: string[] = [];
  let resolveFirst: ((value: { page: MailboxPage }) => void) | undefined;
  const controller = new MailboxController(async (params) => {
    calls.push(params);
    if (params.get('category') === 'primary') return new Promise((resolve) => { resolveFirst = resolve; });
    return { page: { ...makePage('inbox', []), category: 'updates', hasMore: true, nextCursor: 'updates-cursor' } };
  }, { onPage: (page) => applied.push(page.category ?? 'all'), onLoading: () => undefined, onError: () => undefined });
  const stale = controller.refresh('inbox', '', 'all', null, null, 'primary');
  await controller.refresh('inbox', 'invoice', 'unread', { kind: 'address', id: 'personal' }, null, 'updates');
  resolveFirst?.({ page: { ...makePage('inbox', []), category: 'primary' } });
  expect(await stale).toBe(false);
  expect(applied).toEqual(['updates']);
  expect(calls[1].get('category')).toBe('updates');
  expect(calls[1].get('identity')).toBe('address:personal');
  expect(calls[1].get('q')).toBe('invoice');
  await controller.loadMore('inbox', 'invoice', 'unread', { ...makePage('inbox', []), category: 'updates', hasMore: true, nextCursor: 'updates-cursor' }, { kind: 'address', id: 'personal' }, null, 'updates');
  expect(calls[2].get('cursor')).toBe('updates-cursor');
  expect(calls[2].get('category')).toBe('updates');
});

test('does not merge a message from another inbox category into the active tab', () => {
  const incoming = { ...message('incoming', 'inbox', '2026-08-14T02:00:00.000Z'), inboxCategory: 'social' as const };
  const page = { ...makePage('inbox', []), category: 'updates' as const };
  const result = mergeMessageDelta({ mailbox: cloneMailbox(), mailboxPages: { inbox: page }, metrics }, delta(incoming), deltaOptions());
  expect(result.messageApplied).toBe(false);
  expect(result.snapshot.mailbox.inbox).toEqual([]);
  const matched = mergeMessageDelta({ mailbox: cloneMailbox(), mailboxPages: { inbox: page }, metrics }, delta({ ...incoming, inboxCategory: 'updates' }), deltaOptions());
  expect(matched.messageApplied).toBe(true);
});

test('keeps updated read and star flags when another page is appended', () => {
  const first = { ...message('first', 'inbox', '2026-08-14T02:00:00.000Z'), inboxCategory: 'primary' as const };
  const page = { ...makePage('inbox', [first]), category: 'primary' as const, nextCursor: 'next', hasMore: true };
  const state = mergeMailboxPage(snapshot(cloneMailbox()), page, false);
  const patched = mergeMessageDelta(state, delta({ ...first, read: true, starred: true }), deltaOptions());
  expect(patched.snapshot.mailboxPages?.inbox?.messages[0]).toMatchObject({ read: true, starred: true });
  const appended = mergeMailboxPage(patched.snapshot, { ...page, messages: [message('second', 'inbox', '2026-08-13T02:00:00.000Z')], nextCursor: null, hasMore: false }, true);
  expect(appended.mailbox.inbox.find((item) => item.id === 'first')).toMatchObject({ read: true, starred: true });
});


test('trashing an archived inbox message purges every cached view and updates matching counts', () => {
  const archived = { ...message('archived', 'inbox', '2026-08-14T02:00:00.000Z'), archivedAt: '2026-08-14T03:00:00.000Z', starred: true };
  const other = { ...message('other', 'inbox', '2026-08-13T02:00:00.000Z'), archivedAt: '2026-08-13T03:00:00.000Z' };
  const inboxPage = makePage('inbox', []);
  const result = removeMessage({
    mailbox: cloneMailbox(), metrics,
    mailboxPages: {
      inbox: inboxPage,
      archive: { ...makePage('archive', [archived, other]), searchTotal: 2 },
      starred: { ...makePage('starred', [archived]), searchTotal: 1 },
      label: { ...makePage('label', [archived, other]), searchTotal: 2 }
    }
  }, archived.id, 'inbox', 'archive', archived.id);
  expect(result.snapshot.mailboxPages?.archive?.messages.map((item) => item.id)).toEqual(['other']);
  expect(result.snapshot.mailboxPages?.archive?.searchTotal).toBe(1);
  expect(result.snapshot.mailboxPages?.starred?.messages).toEqual([]);
  expect(result.snapshot.mailboxPages?.starred?.searchTotal).toBe(0);
  expect(result.snapshot.mailboxPages?.label?.messages.map((item) => item.id)).toEqual(['other']);
  expect(result.snapshot.mailboxPages?.label?.searchTotal).toBe(1);
  expect(result.snapshot.mailboxPages?.inbox).toBe(inboxPage);
  expect(result.selectedMessageId).toBe('other');
});

describe('mailbox view cache', () => {
  const page = (category: MailboxPage['category'] = 'all'): MailboxPage => ({
    folder: 'inbox', category, messages: [message('cached', 'inbox', '2026-10-09T00:00:00.000Z')],
    limit: 40, nextCursor: 'next', hasMore: true, query: '', filter: 'all', deliveryStatus: null
  });

  test('restores categories and their cursor without requests while fresh', async () => {
    let calls = 0;
    const shown: MailboxPage[] = [];
    const controller = new MailboxController(async () => { calls++; return { page: page() }; }, {
      onPage: (value) => shown.push(value), onLoading: () => {}, onError: () => {}
    }, () => 100);
    controller.seed(page('primary'));
    controller.seed(page('updates'));
    await controller.navigate('inbox', '', 'all', null, null, 'primary');
    await controller.navigate('inbox', '', 'all', null, null, 'updates');
    await controller.navigate('inbox', '', 'all', null, null, 'primary');
    expect(calls).toBe(0);
    expect(shown.map((value) => value.category)).toEqual(['primary', 'updates', 'primary']);
    expect(shown[2].nextCursor).toBe('next');
  });

  test('shows expired content before revalidation and keeps it on failure', async () => {
    let now = 0;
    let fail!: (error: Error) => void;
    const shown: MailboxPage[] = [];
    const loading: boolean[] = [];
    const errors: string[] = [];
    const controller = new MailboxController(() => new Promise((_resolve, reject) => { fail = reject; }), {
      onPage: (value) => shown.push(value), onLoading: (value) => loading.push(value), onError: (value) => errors.push(value)
    }, () => now);
    controller.seed(page());
    now = 30_001;
    const pending = controller.navigate('inbox', '', 'all');
    expect(shown).toHaveLength(1);
    expect(loading).not.toContain(true);
    fail(new Error('offline'));
    expect(await pending).toBe(false);
    expect(shown[0].messages[0].id).toBe('cached');
    expect(errors).toEqual(['offline']);
  });

  test('deduplicates the same pending view and discards responses after invalidation', async () => {
    let resolve!: (value: { page: MailboxPage }) => void;
    let calls = 0;
    const shown: MailboxPage[] = [];
    const controller = new MailboxController(() => { calls++; return new Promise((done) => { resolve = done; }); }, {
      onPage: (value) => shown.push(value), onLoading: () => {}, onError: () => {}
    });
    const first = controller.navigate('inbox', '', 'all');
    const second = controller.navigate('inbox', '', 'all');
    expect(calls).toBe(1);
    controller.invalidate();
    resolve({ page: page() });
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(shown).toEqual([]);
  });

  test('isolates address scopes and clears the cache on auth reset', async () => {
    let calls = 0;
    const controller = new MailboxController(async () => { calls++; return { page: page() }; }, {
      onPage: () => {}, onLoading: () => {}, onError: () => {}
    });
    controller.seed({ ...page(), identityFilter: { kind: 'address', id: 'a' } });
    await controller.navigate('inbox', '', 'all', { kind: 'address', id: 'a' });
    expect(calls).toBe(0);
    await controller.navigate('inbox', '', 'all', { kind: 'address', id: 'b' });
    expect(calls).toBe(1);
    controller.reset();
    await controller.navigate('inbox', '', 'all', { kind: 'address', id: 'a' });
    expect(calls).toBe(2);
  });

  test('updates flags in every category cache without losing the cursor', async () => {
    const shown: MailboxPage[] = [];
    const controller = new MailboxController(async () => { throw new Error('offline'); }, {
      onPage: (value) => shown.push(value), onLoading: () => {}, onError: () => {}
    });
    controller.seed(page('primary'));
    controller.seed(page('all'));
    controller.patchFlags('cached', { read: true });
    await controller.navigate('inbox', '', 'all', null, null, 'primary');
    await controller.navigate('inbox', '', 'all');
    expect(shown.every((value) => value.messages[0].read)).toBe(true);
    expect(shown.every((value) => value.nextCursor === 'next')).toBe(true);
  });

  test('evicts the least recently used view after sixteen contexts', async () => {
    let calls = 0;
    const controller = new MailboxController(async () => { calls++; return { page: page() }; }, {
      onPage: () => {}, onLoading: () => {}, onError: () => {}
    });
    for (let index = 0; index < 17; index++) controller.seed({ ...page(), query: `query-${index}` });
    await controller.navigate('inbox', 'query-16', 'all');
    expect(calls).toBe(0);
    await controller.navigate('inbox', 'query-0', 'all');
    expect(calls).toBe(1);
  });
});

test('signals a page interrupted by flags so navigation can resume after the write', async () => {
  let resolvePage!: (value: { page: MailboxPage }) => void;
  const pending = new Promise<{ page: MailboxPage }>((resolve) => { resolvePage = resolve; });
  const controller = new MailboxController(() => pending, { onPage: () => {}, onLoading: () => {}, onError: () => {} });
  const navigation = controller.navigate('sent', '', 'all');
  expect(controller.patchFlags('inbox-message', { read: true })).toBe(true);
  resolvePage({ page: makePage('sent', [message('sent', 'sent', '2026-10-09T00:00:00Z')]) });
  expect(await navigation).toBe(false);
  expect(controller.patchFlags('inbox-message', { read: true })).toBe(false);
});
