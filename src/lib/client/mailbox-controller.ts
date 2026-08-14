import {
  buildMailThreads,
  cloneMailbox,
  type MailFolder,
  type MailMessage,
  type MailboxPage,
  type MailboxState,
  type MailThread,
  type MessagePatch,
  type WorkspaceMetrics
} from '$lib/domain/mail';
import { LatestRequest } from './latest-request';

export type WorkspaceSection = MailFolder | 'profile';

export type MailFilter = 'all' | 'unread' | 'starred';

export type MessageDelta = {
  message: MailMessage;
  metrics: WorkspaceMetrics;
};

export type MailboxSnapshot = {
  mailbox: MailboxState;
  mailboxPages: Partial<Record<MailFolder, MailboxPage>> | null;
  metrics: WorkspaceMetrics;
};

export type MessageDeltaOptions = {
  currentSection: WorkspaceSection;
  currentSelectedMessageId: string | null;
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
  if (section === 'profile') return preferredMessageId;

  if (section === 'drafts') {
    const list = nextMailbox.drafts;
    return list.find((message) => message.id === preferredMessageId)?.id ?? list[0]?.id ?? null;
  }

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
  const existing = append ? snapshot.mailbox[page.folder] : [];
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of page.messages) byId.set(message.id, message);

  return {
    mailbox: {
      ...snapshot.mailbox,
      [page.folder]: sortMailboxMessages([...byId.values()])
    },
    mailboxPages: {
      ...(snapshot.mailboxPages ?? {}),
      [page.folder]: page
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

  const folder = result.message.folder;
  const current = nextMailbox[folder];
  const index = current.findIndex((item) => item.id === result.message.id);
  if (index >= 0) current[index] = result.message;
  else current.push(result.message);
  nextMailbox[folder] = sortMailboxMessages(current);

  const section = options.section ?? options.currentSection;
  return {
    snapshot: {
      mailbox: nextMailbox,
      mailboxPages: snapshot.mailboxPages,
      metrics: result.metrics
    },
    selectedMessageId: selectNextMessage(
      nextMailbox,
      section,
      options.preferredMessageId ?? options.currentSelectedMessageId
    ),
    section
  };
}

export function removeMessage(
  snapshot: MailboxSnapshot,
  removedId: string,
  folder: MailFolder,
  currentSection: WorkspaceSection,
  currentSelectedMessageId: string | null,
  metrics?: WorkspaceMetrics
) {
  const nextMailbox = cloneMailbox(snapshot.mailbox);
  nextMailbox[folder] = nextMailbox[folder].filter((message) => message.id !== removedId);
  const section = currentSection === 'profile' ? folder : currentSection;
  return {
    snapshot: {
      mailbox: nextMailbox,
      mailboxPages: snapshot.mailboxPages,
      metrics: metrics ?? snapshot.metrics
    },
    selectedMessageId: selectNextMessage(nextMailbox, section, currentSelectedMessageId),
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
  onLoading: (loading: boolean) => void;
  onError: (message: string) => void;
};

export class MailboxController {
  private readonly request = new LatestRequest();

  constructor(
    private readonly fetchPage: MailboxPageFetcher,
    private readonly callbacks: MailboxControllerCallbacks
  ) {}

  async refresh(folder: MailFolder, query: string, filter: MailFilter) {
    const request = this.request.begin();
    this.callbacks.onLoading(true);
    try {
      const params = new URLSearchParams({ folder, limit: '40' });
      this.addFilters(params, query, filter);
      const result = await this.fetchPage(params, request.signal);
      if (request.isCurrent()) {
        this.callbacks.onPage(result.page, false);
        return true;
      }
    } catch (error) {
      if (!request.signal.aborted) this.callbacks.onError(error instanceof Error ? error.message : '刷新邮件列表失败。');
    } finally {
      if (request.isCurrent()) this.callbacks.onLoading(false);
    }
    return false;
  }

  async loadMore(folder: MailFolder, query: string, filter: MailFilter, currentPage: MailboxPage | undefined) {
    if (!currentPage?.nextCursor || !currentPage.hasMore) return;
    const request = this.request.begin();
    this.callbacks.onLoading(true);
    try {
      const params = new URLSearchParams({
        folder,
        cursor: currentPage.nextCursor,
        limit: String(currentPage.limit)
      });
      this.addFilters(params, query, filter);
      const result = await this.fetchPage(params, request.signal);
      if (request.isCurrent()) {
        this.callbacks.onPage(result.page, true);
        return true;
      }
    } catch (error) {
      if (!request.signal.aborted) this.callbacks.onError(error instanceof Error ? error.message : '加载更多邮件失败。');
    } finally {
      if (request.isCurrent()) this.callbacks.onLoading(false);
    }
    return false;
  }

  cancel() {
    this.request.cancel();
  }

  private addFilters(params: URLSearchParams, query: string, filter: MailFilter) {
    if (query.trim()) params.set('q', query.trim());
    if (filter !== 'all') params.set('filter', filter);
  }
}
