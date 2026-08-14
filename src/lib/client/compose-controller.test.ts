import { describe, expect, test } from 'bun:test';
import { ComposeAutosaveController, createEmptyComposeInput, hasComposeContent, serializeComposeInput, withComposeDraftId } from './compose-controller';

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
});
