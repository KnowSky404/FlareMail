import {
  buildMailThreads,
  cloneMailbox,
  cloneProfile,
  type MailboxSection,
  type InboxCategoryFilter,
  type MailboxIdentityFilter,
  type MailboxMetricsScope,
  type MailMessage,
  type MailboxPage,
  type MailboxState,
  type MailThread,
  type MessagePatch,
  type UserProfile,
  type WorkspaceMetrics,
  type WorkspaceSnapshot
} from '$lib/domain/mail';
import { LatestRequest } from './latest-request';

export type WorkspaceSection = MailboxSection | 'trash' | 'profile';

export type MailFilter = 'all' | 'unread' | 'starred';

export type MessageDelta = {
  message: MailMessage;
  metrics: WorkspaceMetrics;
  metricsScope: MailboxMetricsScope;
};

export type MailboxSnapshot = {
  mailbox: MailboxState;
  mailboxPages: Partial<Record<MailboxSection, MailboxPage>> | null;
  metrics: WorkspaceMetrics;
};

export type WorkspaceViewState = MailboxSnapshot & {
  profile: UserProfile;
  activeSection: WorkspaceSection;
  selectedMessageId: string | null;
  selectedMessageIds: string[];
  searchQuery: string;
  mailFilter: MailFilter;
  identityFilter: MailboxIdentityFilter | null;
};

export function createEmptyWorkspaceViewState(): WorkspaceViewState {
  return {
    profile: cloneProfile(),
    mailbox: cloneMailbox(),
    mailboxPages: null,
    metrics: {
      inboxCount: 0,
      archiveCount: 0,
      sentCount: 0,
      draftsCount: 0,
      trashCount: 0,
      unreadCount: 0,
      starredCount: 0,
      queuedCount: 0,
      delayedCount: 0,
      failedCount: 0,
      bouncedCount: 0,
      complainedCount: 0,
      staleDeliveryCount: 0
    },
    activeSection: 'inbox',
    selectedMessageId: null,
    selectedMessageIds: [],
    searchQuery: '',
    mailFilter: 'all',
    identityFilter: null
  };
}

export function workspaceViewStateFromSnapshot(
  snapshot: WorkspaceSnapshot,
  options: { section?: WorkspaceSection; preferredMessageId?: string | null; clearMailView?: boolean } = {}
): WorkspaceViewState {
  const activeSection = options.section ?? snapshot.activeFolder;
  const activePage = activeSection === 'profile' || activeSection === 'trash' ? undefined : snapshot.mailboxPages[activeSection];
  const preferredMessageId = options.preferredMessageId ?? null;
  const selectedMessageId = activeSection === 'profile'
    ? null
    : preferredMessageId
      ? activePage?.messages.some((message) => message.id === preferredMessageId) ? preferredMessageId : null
      : activePage?.messages[0]?.id ?? selectNextMessage(snapshot.mailbox, activeSection, null);

  return {
    ...mailboxSnapshotFromWorkspace(snapshot),
    profile: { ...snapshot.profile },
    activeSection,
    selectedMessageId,
    selectedMessageIds: [],
    searchQuery: options.clearMailView ? '' : activePage?.query ?? '',
    mailFilter: options.clearMailView ? 'all' : activePage?.filter ?? 'all',
    identityFilter: activeSection === 'trash' || options.clearMailView ? null : activePage?.identityFilter ?? null
  };
}

export function reconcileBulkSelection(selectedMessageIds: string[], messages: MailMessage[]) {
  const validIds = new Set(messages.map((message) => message.id));
  return [...new Set(selectedMessageIds)].filter((id) => validIds.has(id));
}

export function mailboxSnapshotFromWorkspace(snapshot: WorkspaceSnapshot): MailboxSnapshot {
  return {
    mailbox: cloneMailbox(snapshot.mailbox),
    mailboxPages: { ...snapshot.mailboxPages },
    metrics: snapshot.metrics
  };
}

export type MessageDeltaOptions = {
  currentSection: WorkspaceSection;
  currentSelectedMessageId: string | null;
  identityFilter: MailboxIdentityFilter | null;
  identityAddresses: Array<{ id: string; domainId: string }>;
  query: string;
  filter: MailFilter;
  section?: WorkspaceSection;
  preferredMessageId?: string | null;
  removeDraftId?: string;
};

export function sortMailboxMessages(messages: MailMessage[]) {
  return [...messages].sort(
    (left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id)
  );
}

export function selectNextMessage(
  nextMailbox: MailboxState,
  section: WorkspaceSection,
  preferredMessageId: string | null = null
) {
  if (section === 'profile' || section === 'trash') return preferredMessageId;

  if (section === 'drafts') {
    const list = nextMailbox.drafts;
    return list.find((message) => message.id === preferredMessageId)?.id ?? list[0]?.id ?? null;
  }

  if (section === 'archive' || section === 'starred' || section === 'label') return preferredMessageId;

  const threads = buildMailThreads(nextMailbox, section);
  const preferredThread = preferredMessageId
    ? threads.find((thread) => thread.messages.some((message) => message.id === preferredMessageId))
    : null;

  return preferredThread && preferredMessageId
    ? preferredMessageId
    : threads[0]?.sectionLatestMessage.id ?? null;
}

export function selectionCandidates(
  mailbox: MailboxState,
  section: WorkspaceSection,
  visibleMessages: MailMessage[],
  visibleThreads: MailThread[]
) {
  return section === 'drafts'
    ? visibleMessages
    : section === 'profile'
      ? []
      : section === 'trash'
        ? visibleMessages
      : visibleThreads.map((thread) => thread.sectionLatestMessage);
}

export function moveSelection(
  candidates: MailMessage[],
  selectedMessageId: string | null,
  direction: -1 | 1
) {
  if (!candidates.length) return null;
  const currentIndex = candidates.findIndex((message) => message.id === selectedMessageId);
  const fallbackIndex = direction > 0 ? 0 : candidates.length - 1;
  const nextIndex =
    currentIndex < 0
      ? fallbackIndex
      : Math.min(candidates.length - 1, Math.max(0, currentIndex + direction));
  return candidates[nextIndex] ?? null;
}

export function mergeMailboxPage(snapshot: MailboxSnapshot, page: MailboxPage, append: boolean): MailboxSnapshot {
  const previousPage = snapshot.mailboxPages?.[page.folder];
  const existing = append ? previousPage?.messages ?? [] : [];
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of page.messages) byId.set(message.id, message);

  const mergedPage = {
    ...page,
    ...(append && page.searchTotal === undefined && previousPage?.searchTotal !== undefined
      ? { searchTotal: previousPage.searchTotal, searchHitFields: previousPage.searchHitFields }
      : {}),
    messages: sortMailboxMessages([...byId.values()])
  };
  const nextMailbox = page.folder === 'archive' || page.folder === 'starred' || page.folder === 'label'
    ? snapshot.mailbox
    : {
      ...snapshot.mailbox,
      [page.folder]: mergedPage.messages
    };
  return {
    mailbox: nextMailbox,
    mailboxPages: {
      ...(snapshot.mailboxPages ?? {}),
      [page.folder]: mergedPage
    },
    metrics: page.metrics ?? snapshot.metrics
  };
}

export function mergeMessageDelta(
  snapshot: MailboxSnapshot,
  result: MessageDelta,
  options: MessageDeltaOptions
) {
  const nextMailbox = cloneMailbox(snapshot.mailbox);
  if (options.removeDraftId) {
    nextMailbox.drafts = nextMailbox.drafts.filter((item) => item.id !== options.removeDraftId);
  }

  const section = options.section ?? options.currentSection;
  const targetPage = section === 'profile' || section === 'trash' ? undefined : snapshot.mailboxPages?.[section];
  const identityFilter = options.identityFilter ?? null;
  const identityAddresses = options.identityAddresses ?? [];
  const responseScope = result.metricsScope ?? { identityFilter: null };
  const sameIdentityFilter = (left: MailboxIdentityFilter | null | undefined, right: MailboxIdentityFilter | null | undefined) =>
    (left?.kind ?? null) === (right?.kind ?? null) && (left?.id ?? null) === (right?.id ?? null);
  const metricsApplied = sameIdentityFilter(responseScope.identityFilter, identityFilter);
  const addressId = result.message.folder === 'sent' || result.message.folder === 'drafts'
    ? result.message.senderAddressId
    : result.message.recipientAddressId;
  const identityMatches = !identityFilter || Boolean(addressId && (
    identityFilter.kind === 'address'
      ? addressId === identityFilter.id
      : identityAddresses.some((address) => address.id === addressId && address.domainId === identityFilter.id)
  ));
  const pageMatchesCurrentScope = !targetPage || sameIdentityFilter(targetPage.identityFilter, identityFilter);
  const query = targetPage?.query ?? (section === options.currentSection ? options.query ?? '' : '');
  const filter = targetPage?.filter ?? (section === options.currentSection ? options.filter ?? 'all' : 'all');
  const categoryMatches = section !== 'inbox' || !targetPage?.category || targetPage.category === 'all' || result.message.inboxCategory === targetPage.category;
  const canMergeMessage = categoryMatches && section !== 'starred' && section !== 'label' && identityMatches && pageMatchesCurrentScope && !query.trim() && filter === 'all';

  if (options.removeDraftId && snapshot.mailboxPages?.drafts) {
    const draftsPage = snapshot.mailboxPages.drafts;
    snapshot = {
      ...snapshot,
      mailboxPages: {
        ...snapshot.mailboxPages,
        drafts: { ...draftsPage, messages: draftsPage.messages.filter((item) => item.id !== options.removeDraftId) }
      }
    };
  }

  if (!canMergeMessage) {
    for (const folder of ['inbox', 'sent', 'drafts'] as const) {
      nextMailbox[folder] = nextMailbox[folder].filter((item) => item.id !== result.message.id);
    }
    if (targetPage && pageMatchesCurrentScope) {
      snapshot = {
        ...snapshot,
        mailboxPages: {
          ...(snapshot.mailboxPages ?? {}),
          [section]: { ...targetPage, messages: targetPage.messages.filter((item) => item.id !== result.message.id) }
        }
      };
    }
    return {
      snapshot: { ...snapshot, mailbox: nextMailbox, metrics: metricsApplied ? result.metrics : snapshot.metrics },
      selectedMessageId: options.currentSelectedMessageId,
      section,
      messageApplied: false,
      metricsApplied
    };
  }

  if (section === 'archive') {
    const page = snapshot.mailboxPages?.archive;
    const nextMessages = sortMailboxMessages([
      ...(page?.messages ?? []).filter((item) => item.id !== result.message.id),
      result.message
    ]);
    const nextPage: MailboxPage = page
      ? { ...page, messages: nextMessages }
      : {
        folder: 'archive',
        messages: nextMessages,
        nextCursor: null,
        hasMore: false,
        limit: 40,
        query: '',
        filter: 'all',
        identityFilter,
        deliveryStatus: null
      };
    return {
      snapshot: {
        mailbox: nextMailbox,
        mailboxPages: { ...(snapshot.mailboxPages ?? {}), archive: nextPage },
        metrics: metricsApplied ? result.metrics : snapshot.metrics
      },
      selectedMessageId: options.preferredMessageId ?? options.currentSelectedMessageId,
      section,
      messageApplied: true,
      metricsApplied
    };
  }

  const folder = result.message.folder;
  const current = nextMailbox[folder];
  const index = current.findIndex((item) => item.id === result.message.id);
  if (index >= 0) current[index] = result.message;
  else current.push(result.message);
  nextMailbox[folder] = sortMailboxMessages(current);

  return {
    snapshot: {
      mailbox: nextMailbox,
      mailboxPages: targetPage && section === folder
        ? { ...snapshot.mailboxPages, [folder]: { ...targetPage, messages: nextMailbox[folder] } }
        : snapshot.mailboxPages,
      metrics: metricsApplied ? result.metrics : snapshot.metrics
    },
    selectedMessageId: selectNextMessage(
      nextMailbox,
      section,
      options.preferredMessageId ?? options.currentSelectedMessageId
    ),
    section,
    messageApplied: true,
    metricsApplied
  };
}

export function removeMessage(
  snapshot: MailboxSnapshot,
  removedId: string,
  folder: MailboxSection,
  currentSection: WorkspaceSection,
  currentSelectedMessageId: string | null,
  metrics?: WorkspaceMetrics
) {
  const nextMailbox = cloneMailbox(snapshot.mailbox);
  if (folder !== 'archive' && folder !== 'starred' && folder !== 'label') nextMailbox[folder] = nextMailbox[folder].filter((message) => message.id !== removedId);
  const section = currentSection === 'profile' ? folder : currentSection;
  // One persisted inbox message can also appear in archive, Starred and label
  // caches. Purge every cached occurrence so Back and the active archive cannot
  // resurrect a trashed row without a server refresh.
  const mailboxPages = snapshot.mailboxPages
    ? Object.fromEntries(Object.entries(snapshot.mailboxPages).map(([key, page]) => {
      if (!page || !page.messages.some((message) => message.id === removedId)) return [key, page];
      return [key, {
        ...page,
        messages: page.messages.filter((message) => message.id !== removedId),
        ...(page.searchTotal !== undefined ? { searchTotal: Math.max(0, page.searchTotal - 1) } : {})
      }];
    })) as Partial<Record<MailboxSection, MailboxPage>>
    : null;
  const crossFolderPage = section === 'archive' || section === 'starred' || section === 'label'
    ? mailboxPages?.[section] : undefined;
  return {
    snapshot: {
      mailbox: nextMailbox,
      mailboxPages,
      metrics: metrics ?? snapshot.metrics
    },
    selectedMessageId: crossFolderPage
      ? crossFolderPage.messages.find((message) => message.id === currentSelectedMessageId)?.id ?? crossFolderPage.messages[0]?.id ?? null
      : selectNextMessage(nextMailbox, section, currentSelectedMessageId),
    section
  };
}

export type FlagDelta = Pick<MessagePatch, 'read' | 'starred'>;

type MailboxPageFetcher = (
  params: URLSearchParams,
  signal: AbortSignal
) => Promise<{ page: MailboxPage }>;

type MailboxControllerCallbacks = {
  onPage: (page: MailboxPage, append: boolean) => void;
  onLoading: (loading: boolean, append: boolean) => void;
  onError: (message: string) => void;
  onRefreshing?: (refreshing: boolean) => void;
};

/** Session-local view cache. No mailbox data is stored in browser persistence. */
export class MailboxController {
  private readonly request = new LatestRequest();
  private readonly cache = new Map<string, { page: MailboxPage; updatedAt: number }>();
  private loadingAppend: boolean | null = null;
  private inFlight: { key: string; promise: Promise<boolean> } | null = null;

  constructor(
    private readonly fetchPage: MailboxPageFetcher,
    private readonly callbacks: MailboxControllerCallbacks,
    private readonly now: () => number = Date.now
  ) {}

  seed(page: MailboxPage) {
    this.remember(this.keyForPage(page), page);
  }

  navigate(folder: MailboxSection, query: string, filter: MailFilter, identityFilter: MailboxIdentityFilter | null = null, labelId: string | null = null, category: InboxCategoryFilter = 'all') {
    return this.fetch(folder, query, filter, identityFilter, labelId, category, false);
  }

  refresh(folder: MailboxSection, query: string, filter: MailFilter, identityFilter: MailboxIdentityFilter | null = null, labelId: string | null = null, category: InboxCategoryFilter = 'all') {
    return this.fetch(folder, query, filter, identityFilter, labelId, category, true);
  }

  private fetch(folder: MailboxSection, query: string, filter: MailFilter, identityFilter: MailboxIdentityFilter | null, labelId: string | null, category: InboxCategoryFilter, force: boolean): Promise<boolean> {
    const params = this.params(folder, query, filter, identityFilter, labelId, category);
    const key = params.toString();
    if (this.inFlight?.key === key) return this.inFlight.promise;
    this.cancel();
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.callbacks.onPage(cached.page, false);
      if (!force && this.now() - cached.updatedAt < 30_000) return Promise.resolve(true);
    }
    const request = this.request.begin();
    this.setLoading(!cached, false);
    this.callbacks.onRefreshing?.(Boolean(cached));
    const promise = (async () => {
      try {
        const result = await this.fetchPage(params, request.signal);
        if (!request.isCurrent()) return false;
        this.remember(key, result.page);
        this.callbacks.onPage(result.page, false);
        return true;
      } catch (error) {
        if (request.isCurrent()) this.callbacks.onError(error instanceof Error ? error.message : '刷新邮件列表失败。');
        return false;
      } finally {
        if (request.isCurrent()) {
          this.inFlight = null;
          this.setLoading(false, false);
          this.callbacks.onRefreshing?.(false);
        }
      }
    })();
    this.inFlight = { key, promise };
    return promise;
  }

  async loadMore(folder: MailboxSection, query: string, filter: MailFilter, currentPage: MailboxPage | undefined, identityFilter: MailboxIdentityFilter | null = null, labelId: string | null = null, category: InboxCategoryFilter = 'all') {
    if (!currentPage?.nextCursor || !currentPage.hasMore) return;
    this.cancel();
    const request = this.request.begin();
    this.setLoading(true, true);
    const params = this.params(folder, query, filter, identityFilter, labelId, category, currentPage.limit);
    const key = params.toString();
    params.set('cursor', currentPage.nextCursor);
    try {
      const result = await this.fetchPage(params, request.signal);
      if (!request.isCurrent()) return false;
      const merged = mergeMailboxPage({ mailbox: cloneMailbox(), mailboxPages: { [folder]: currentPage }, metrics: createEmptyWorkspaceViewState().metrics }, result.page, true);
      this.remember(key, merged.mailboxPages![folder]!);
      this.callbacks.onPage(result.page, true);
      return true;
    } catch (error) {
      if (request.isCurrent()) this.callbacks.onError(error instanceof Error ? error.message : '加载更多邮件失败。');
    } finally {
      if (request.isCurrent()) this.setLoading(false, true);
    }
    return false;
  }

  /** Invalidates requests as well as freshness: old pages cannot undo a write. */
  invalidate() {
    this.cancel();
    for (const entry of this.cache.values()) {
      entry.updatedAt = Number.NEGATIVE_INFINITY;
      entry.page = { ...entry.page, metrics: undefined };
    }
  }

  patchFlags(id: string, patch: FlagDelta) {
    const interrupted = this.inFlight !== null || this.loadingAppend !== null;
    this.invalidate();
    for (const entry of this.cache.values()) entry.page = patchPageFlags(entry.page, id, patch);
    return interrupted;
  }

  reset() {
    this.cancel();
    this.cache.clear();
  }

  cancel() {
    const append = this.loadingAppend;
    this.request.cancel();
    this.inFlight = null;
    if (append !== null) this.setLoading(false, append);
    this.callbacks.onRefreshing?.(false);
  }

  private remember(key: string, page: MailboxPage) {
    this.cache.delete(key);
    this.cache.set(key, { page: { ...page, messages: [...page.messages] }, updatedAt: this.now() });
    while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
  }

  private keyForPage(page: MailboxPage) {
    return this.params(page.folder, page.query, page.filter, page.identityFilter ?? null, page.labelId ?? null, page.category ?? 'all', page.limit).toString();
  }

  private setLoading(loading: boolean, append: boolean) {
    this.loadingAppend = loading ? append : null;
    this.callbacks.onLoading(loading, append);
  }

  private params(folder: MailboxSection, query: string, filter: MailFilter, identityFilter: MailboxIdentityFilter | null, labelId: string | null, category: InboxCategoryFilter, limit = 40) {
    const params = new URLSearchParams({ folder, limit: String(limit) });
    if (folder === 'inbox' && category !== 'all') params.set('category', category);
    if (query.trim()) params.set('q', query.trim());
    if (filter !== 'all') params.set('filter', filter);
    if (identityFilter) params.set('identity', `${identityFilter.kind}:${identityFilter.id}`);
    if (labelId) params.set('label', labelId);
    return params;
  }
}

function patchPageFlags(page: MailboxPage, id: string, patch: FlagDelta): MailboxPage {
  return { ...page, messages: page.messages.map((message) => message.id === id ? { ...message, ...patch } : message)
    .filter((message) => message.id !== id || (
      (page.filter !== 'unread' || !message.read) && (page.filter !== 'starred' || message.starred) &&
      (page.folder !== 'starred' || message.starred)
    )) };
}

/** Flags update existing rows only, preserving body/labels and the page cursor. */
export function patchMailboxFlags(snapshot: MailboxSnapshot, id: string, patch: FlagDelta): MailboxSnapshot {
  const pages = snapshot.mailboxPages ? Object.fromEntries(Object.entries(snapshot.mailboxPages).map(([key, page]) =>
    [key, page ? patchPageFlags(page, id, patch) : page]
  )) as Partial<Record<MailboxSection, MailboxPage>> : null;
  const mailbox = cloneMailbox(snapshot.mailbox);
  for (const folder of ['inbox', 'sent', 'drafts'] as const) {
    mailbox[folder] = pages?.[folder]?.messages ?? mailbox[folder].map((message) => message.id === id ? { ...message, ...patch } : message);
  }
  return { ...snapshot, mailbox, mailboxPages: pages };
}
