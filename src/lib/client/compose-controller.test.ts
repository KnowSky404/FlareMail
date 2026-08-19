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
    expect(composeInputFromSavedDraft(savedDraft())).toMatchObject({
      draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:00.000Z'
    });
    expect(withComposePersistence({ toEmail: '', subject: 'Latest edit', body: 'B' }, {
      draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:01.000Z'
    })).toMatchObject({
      subject: 'Latest edit', draftId: 'draft-1', expectedUpdatedAt: '2026-08-19T10:00:01.000Z'
    });
  });

  test('updates only persisted metadata when an earlier request finishes after a later edit', () => {
    const local = { ...composeInputFromSavedDraft(savedDraft()), body: 'newer local edit' };
    const merged = mergeSavedDraftMetadata(local, savedDraft({ sentAt: '2026-08-19T10:00:01.000Z', body: 'older request body' }));
    expect(merged.body).toBe('newer local edit');
    expect(merged.expectedUpdatedAt).toBe('2026-08-19T10:00:01.000Z');
  });
});
