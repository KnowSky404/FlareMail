import { describe, expect, test } from 'bun:test';
import type { MailMessage } from '$lib/domain/mail';
import {
  ComposeAutosaveController,
  composeInputFromSavedDraft,
  createEmptyComposeInput,
  hasComposeContent,
  mergeSavedDraftMetadata,
  serializeComposeInput,
  withComposeDraftId,
  withComposePersistence
} from './compose-controller';

const savedDraft = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  id: 'draft-1', folder: 'drafts', source: 'workspace', fromName: 'Owner', fromEmail: 'owner@example.com',
  toName: 'Alice', toEmail: 'alice@example.com', subject: 'Subject', preview: 'Body', body: 'Body',
  sentAt: '2026-08-19T10:00:00.000Z', labels: ['Draft'], read: true, starred: false,
  messageId: null, inReplyTo: null, references: null, ...overrides
});

describe('compose controller', () => {
  test('keeps serialization stable and treats whitespace-only input as empty', () => {
    const input = createEmptyComposeInput();
    expect(hasComposeContent(input)).toBe(false);
    expect(serializeComposeInput(withComposeDraftId({ ...input, toEmail: ' owner@example.com ' }, 'draft-1'))).toContain('draft-1');
  });

  test('invalidates a pending autosave when the compose session changes', () => {
    const controller = new ComposeAutosaveController();
    const pending = controller.sequence.begin();
    controller.changed();
    expect(pending.isCurrent()).toBe(false);
    controller.reset();
    expect(pending.isActive()).toBe(false);
  });

  test('carries the optimistic-concurrency version for existing and newly saved drafts', () => {
    expect(composeInputFromSavedDraft(savedDraft(), 'body-object-1')).toMatchObject({
      draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:00.000Z', bodyRevision: 'body-object-1'
    });
    expect(withComposePersistence({ toEmail: '', subject: 'Latest edit', body: 'B' }, {
      draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:01.000Z', bodyRevision: 'body-object-2'
    })).toMatchObject({
      subject: 'Latest edit', draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:01.000Z', bodyRevision: 'body-object-2'
    });
  });

  test('keeps authoritative persistence metadata when closing a stale modal snapshot', () => {
    const staleModal = {
      ...composeInputFromSavedDraft(savedDraft(), 'body-object-1'),
      subject: 'Latest modal edit'
    };
    const closing = withComposePersistence(staleModal, {
      draftId: 'draft-1',
      expectedUpdatedAt: '2026-08-19T10:00:02.000Z',
      bodyRevision: 'body-object-3'
    });
    expect(closing).toMatchObject({
      subject: 'Latest modal edit',
      draftId: 'draft-1',
      expectedUpdatedAt: '2026-08-19T10:00:02.000Z',
      bodyRevision: 'body-object-3'
    });
  });

  test('updates only persisted metadata when an earlier request finishes after a later edit', () => {
    const local = { ...composeInputFromSavedDraft(savedDraft()), body: 'newer local edit' };
    const merged = mergeSavedDraftMetadata(local, savedDraft({ sentAt: '2026-08-19T10:00:01.000Z', body: 'older request body' }), 'body-object-2');
    expect(merged.body).toBe('newer local edit');
    expect(merged.expectedUpdatedAt).toBe('2026-08-19T10:00:01.000Z');
    expect(merged.bodyRevision).toBe('body-object-2');
  });

  test('treats attachments as content and preserves their optimistic revision in draft metadata', () => {
    const attachment = { id: 'attachment-1', filename: 'evidence.txt', contentType: 'text/plain', size: 8, inline: false };
    const input = { ...createEmptyComposeInput(), attachments: [attachment], attachmentRevision: 3 };
    expect(hasComposeContent(input)).toBe(true);
    expect(serializeComposeInput(input)).toContain('attachment-1');
    expect(composeInputFromSavedDraft(savedDraft(), null, [attachment], 3)).toMatchObject({
      attachments: [attachment], attachmentRevision: 3
    });
    expect(mergeSavedDraftMetadata({ ...input, body: 'local' }, savedDraft(), null, [attachment], 4)).toMatchObject({
      body: 'local', attachments: [attachment], attachmentRevision: 4
    });
  });
});
