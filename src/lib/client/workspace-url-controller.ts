import type { MailboxIdentityFilter, MailboxSection } from '$lib/domain/mail';
import type { MailFilter, WorkspaceSection } from './mailbox-controller';

export type WorkspaceUrlState = {
  section: WorkspaceSection;
  managementView: 'settings' | 'domains' | 'addresses';
  managementDomainId: string | null;
  query: string;
  filter: MailFilter;
  identityFilter: MailboxIdentityFilter | null;
  messageId: string | null;
};

export type WorkspaceUrlUpdates = {
  section?: WorkspaceSection;
  managementView?: WorkspaceUrlState['managementView'];
  managementDomainId?: string | null;
  query?: string;
  filter?: MailFilter;
  identityFilter?: MailboxIdentityFilter | null;
  messageId?: string | null;
};

export function readWorkspaceUrl(url: URL): WorkspaceUrlState {
  const folder = url.searchParams.get('folder');
  const section = folder === 'sent' || folder === 'drafts' || folder === 'archive' || folder === 'starred' || folder === 'trash' ? folder : folder === 'settings' ? 'profile' : 'inbox';
  const filter = url.searchParams.get('filter');
  const view = url.searchParams.get('view');
  const managementDomainId = url.searchParams.get('domain');
  const identity = url.searchParams.get('identity');
  const identityMatch = identity?.match(/^(domain|address):([A-Za-z0-9:._-]{1,128})$/u);
  return {
    section,
    managementView: section === 'profile' && (view === 'domains' || view === 'addresses') ? view : 'settings',
    managementDomainId: section === 'profile' && view === 'addresses' && managementDomainId && /^[A-Za-z0-9:._-]{1,128}$/u.test(managementDomainId)
      ? managementDomainId : null,
    query: section === 'trash' || section === 'profile' ? '' : url.searchParams.get('q')?.slice(0, 200) ?? '',
    filter: section !== 'trash' && section !== 'profile' && (filter === 'unread' || filter === 'starred') ? filter : 'all',
    identityFilter: section !== 'trash' && section !== 'profile' && identityMatch ? { kind: identityMatch[1] as 'domain' | 'address', id: identityMatch[2] } : null,
    messageId: section === 'profile' ? null : url.searchParams.get('message')
  };
}

export function updateWorkspaceUrl(url: URL, updates: WorkspaceUrlUpdates) {
  const next = new URL(url);
  if (updates.section) next.searchParams.set('folder', updates.section === 'profile' ? 'settings' : updates.section);
  if (updates.managementView !== undefined || updates.section !== undefined) {
    const targetSection = updates.section ?? readWorkspaceUrl(url).section;
    if (targetSection === 'profile' && updates.managementView && updates.managementView !== 'settings') {
      next.searchParams.set('view', updates.managementView);
    } else {
      next.searchParams.delete('view');
    }
  }
  if (updates.managementDomainId !== undefined || updates.managementView !== undefined || updates.section !== undefined) {
    if ((updates.section ?? readWorkspaceUrl(url).section) === 'profile' && (updates.managementView ?? readWorkspaceUrl(url).managementView) === 'addresses' && updates.managementDomainId) {
      next.searchParams.set('domain', updates.managementDomainId);
    } else {
      next.searchParams.delete('domain');
    }
  }
  if (updates.query !== undefined) {
    const query = updates.query.trim().slice(0, 200);
    if (query) next.searchParams.set('q', query);
    else next.searchParams.delete('q');
  }
  if (updates.filter !== undefined) {
    if (updates.filter === 'all') next.searchParams.delete('filter');
    else next.searchParams.set('filter', updates.filter);
  }
  if (updates.identityFilter !== undefined) {
    if (updates.identityFilter) next.searchParams.set('identity', `${updates.identityFilter.kind}:${updates.identityFilter.id}`);
    else next.searchParams.delete('identity');
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
