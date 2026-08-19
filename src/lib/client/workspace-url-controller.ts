import type { MailboxSection } from '$lib/domain/mail';
import type { MailFilter, WorkspaceSection } from './mailbox-controller';

export type WorkspaceUrlState = {
  section: WorkspaceSection;
  query: string;
  filter: MailFilter;
  messageId: string | null;
};

export type WorkspaceUrlUpdates = {
  section?: WorkspaceSection;
  query?: string;
  filter?: MailFilter;
  messageId?: string | null;
};

export function readWorkspaceUrl(url: URL): WorkspaceUrlState {
  const folder = url.searchParams.get('folder');
  const filter = url.searchParams.get('filter');
  return {
    section: folder === 'sent' || folder === 'drafts' || folder === 'archive' || folder === 'trash' ? folder : folder === 'settings' ? 'profile' : 'inbox',
    query: url.searchParams.get('q')?.slice(0, 200) ?? '',
    filter: filter === 'unread' || filter === 'starred' ? filter : 'all',
    messageId: url.searchParams.get('message')
  };
}

export function updateWorkspaceUrl(url: URL, updates: WorkspaceUrlUpdates) {
  const next = new URL(url);
  if (updates.section) next.searchParams.set('folder', updates.section === 'profile' ? 'settings' : updates.section);
  if (updates.query !== undefined) {
    const query = updates.query.trim().slice(0, 200);
    if (query) next.searchParams.set('q', query);
    else next.searchParams.delete('q');
  }
  if (updates.filter !== undefined) {
    if (updates.filter === 'all') next.searchParams.delete('filter');
    else next.searchParams.set('filter', updates.filter);
  }
  if (updates.messageId !== undefined) {
    if (updates.messageId) next.searchParams.set('message', updates.messageId);
    else next.searchParams.delete('message');
  }
  return next;
}

export function folderFromSection(section: WorkspaceSection): MailboxSection | null {
  return section === 'profile' || section === 'trash' ? null : section;
}
