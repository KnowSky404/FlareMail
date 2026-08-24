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

const metrics: WorkspaceMetrics = { inboxCount: 1, sentCount: 0, draftsCount: 0, trashCount: 0, unreadCount: 1, starredCount: 0,
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
      outboundSenderEmail: 'mailer@example.com'
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
      outboundSenderEmail: 'mailer@example.com'
    }, { section: 'inbox', preferredMessageId: 'inbox', clearMailView: true });

    expect(state.metrics).toMatchObject({ inboxCount: 45, sentCount: 3, draftsCount: 2 });
    expect(state.mailboxPages?.inbox?.nextCursor).toBe('next');
    expect(state.selectedMessageId).toBe('inbox');
    expect(state.selectedMessageIds).toEqual([]);
    expect(state.searchQuery).toBe('');
    expect(state.mailFilter).toBe('all');
    expect(state.outboundSenderEmail).toBe('mailer@example.com');
  });

  test('resets every user-scoped view field and reconciles selections on replacement', () => {
    const empty = createEmptyWorkspaceViewState();
    expect(empty).toMatchObject({
      activeSection: 'inbox', selectedMessageId: null, selectedMessageIds: [], searchQuery: '', mailFilter: 'all',
      mailboxPages: null, outboundSenderEmail: null
    });
    const first = message('first', 'inbox', '2026-08-14T02:00:00.000Z');
    const second = message('second', 'inbox', '2026-08-14T01:00:00.000Z');
    expect(reconcileBulkSelection(['first', 'stale', 'first'], [first, second])).toEqual(['first']);
  });

  test('applies a delta without changing unrelated folders and selects the result', () => {
    const inbox = message('inbox', 'inbox', '2026-08-14T02:00:00.000Z');
    const draft = message('draft', 'drafts', '2026-08-14T01:00:00.000Z');
    const result = mergeMessageDelta(snapshot({ ...cloneMailbox(), inbox: [inbox], drafts: [draft] }), {
      message: { ...inbox, starred: true },
      metrics
    }, {
      currentSection: 'inbox',
      currentSelectedMessageId: inbox.id
    });

    expect(result.snapshot.mailbox.inbox[0]?.starred).toBe(true);
    expect(result.snapshot.mailbox.drafts[0]?.id).toBe('draft');
    expect(result.selectedMessageId).toBe('inbox');
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
});

function makePage(folder: MailMessage['folder'], messages: MailMessage[]) {
  return {
    folder,
    messages,
    nextCursor: null,
    hasMore: false,
    limit: 40,
    query: '',
    filter: 'all' as const,
    deliveryStatus: null
  };
}
