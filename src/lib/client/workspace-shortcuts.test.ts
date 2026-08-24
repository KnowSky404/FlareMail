import { describe, expect, test } from 'bun:test';
import { WorkspaceShortcutController } from './workspace-shortcuts';

const context = { helpOpen: false, mobileDetailOpen: false, canReply: true, canReplyAll: true, canForward: true };
const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => {
  let prevented = false;
  const event = {
    key: value,
    target: null,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => { prevented = true; },
    ...overrides
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
};

describe('WorkspaceShortcutController', () => {
  test('maps task shortcuts and guards contextual actions', () => {
    const controller = new WorkspaceShortcutController();
    expect(controller.handle(key('/').event, context)).toBe('focus-search');
    expect(controller.handle(key('r').event, { ...context, canReply: false })).toBeNull();
    expect(controller.handle(key('a').event, context)).toBe('reply-all');
    expect(controller.handle(key('a').event, { ...context, canReplyAll: false })).toBeNull();
    expect(controller.handle(key('Escape').event, { ...context, helpOpen: true })).toBe('close-help');
    controller.dispose();
  });

  test('maps a g prefix to folder navigation', () => {
    const controller = new WorkspaceShortcutController();
    const prefix = key('g');
    expect(controller.handle(prefix.event, context)).toBeNull();
    expect(controller.handle(key('s').event, context)).toBe('folder-sent');
    expect(prefix.prevented()).toBe(true);
    controller.dispose();
  });
});
