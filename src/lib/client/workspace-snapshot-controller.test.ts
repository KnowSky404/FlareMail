import { describe, expect, test } from 'bun:test';
import { WorkspaceSnapshotController } from './workspace-snapshot-controller';

describe('WorkspaceSnapshotController', () => {
  test('applies each explicit server snapshot identity once', () => {
    const controller = new WorkspaceSnapshotController();

    expect(controller.accept('request-1', 'owner@example.test')).toEqual({
      apply: true,
      announceRestore: true,
      resetUserScoped: false
    });
    expect(controller.accept('request-1', 'owner@example.test')).toEqual({
      apply: false,
      announceRestore: false,
      resetUserScoped: false
    });
    expect(controller.accept('request-2', 'owner@example.test')).toEqual({
      apply: true,
      announceRestore: false,
      resetUserScoped: false
    });
  });

  test('requests user-scoped cleanup when the authenticated identity changes', () => {
    const controller = new WorkspaceSnapshotController();
    controller.noteUser('first@example.test');

    expect(controller.accept('request-2', 'second@example.test').resetUserScoped).toBe(true);
    controller.reset();
    expect(controller.accept('request-3', 'second@example.test').announceRestore).toBe(true);
  });
});
