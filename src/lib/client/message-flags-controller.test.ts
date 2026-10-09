import { describe, expect, test } from 'bun:test';
import type { MailMessage } from '$lib/domain/mail';
import { createEmptyWorkspaceViewState } from './mailbox-controller';
import { MessageFlagsController, ReadActivationController } from './message-flags-controller';

const message = { id: 'mail', folder: 'inbox', read: false, starred: false } as MailMessage;
const result = (read: boolean, starred: boolean) => ({
  message: { ...message, read, starred }, metrics: createEmptyWorkspaceViewState().metrics,
  metricsScope: { identityFilter: null }
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('message flags and reader activation', () => {
  test('auto-reads once per visible opening, preserving a manual unread', () => {
    const activation = new ReadActivationController();
    expect(activation.activate(null)).toBe(false);
    expect(activation.activate(message)).toBe(true);
    expect(activation.activate({ ...message, read: true })).toBe(false);
    expect(activation.activate(message)).toBe(false);
    activation.activate(null);
    expect(activation.activate(message)).toBe(true);
    expect(activation.activate({ ...message, id: 'sent', folder: 'sent' })).toBe(false);
  });

  test('serializes writes and does not let a late read overwrite newer unread intent', async () => {
    let visible = { ...message };
    const sent: string[] = [];
    const first = deferred<ReturnType<typeof result>>();
    const controller = new MessageFlagsController({
      onPatch: (_id, patch) => { visible = { ...visible, ...patch }; }, onConfirmed: () => {}, onError: () => {}
    });
    const read = controller.update(visible, { read: true }, () => { sent.push('read'); return first.promise; });
    const unread = controller.update(visible, { read: false }, async () => { sent.push('unread'); return result(false, false); });
    await Promise.resolve();
    expect(sent).toEqual(['read']);
    expect(visible.read).toBe(false);
    first.resolve(result(true, false));
    await read;
    expect(visible.read).toBe(false);
    await unread;
    expect(sent).toEqual(['read', 'unread']);
    expect(visible.read).toBe(false);
    expect(controller.busy).toBe(false);
  });

  test('rolls back a failed read independently of a newer star and overlays stale pages', async () => {
    let visible = { ...message };
    const first = deferred<ReturnType<typeof result>>();
    const errors: unknown[] = [];
    const controller = new MessageFlagsController({
      onPatch: (_id, patch) => { visible = { ...visible, ...patch }; }, onConfirmed: () => {}, onError: (error) => errors.push(error)
    });
    const read = controller.update(visible, { read: true }, () => first.promise);
    const star = controller.update(visible, { starred: true }, async () => result(false, true));
    expect(controller.overlay(message)).toMatchObject({ read: true, starred: true });
    first.reject(new Error('offline'));
    expect(await read).toBe(false);
    expect(visible).toMatchObject({ read: false, starred: true });
    expect(await star).toBe(true);
    expect(errors).toHaveLength(1);
  });

  test('auth reset discards late confirmations and queued unsent writes', async () => {
    const first = deferred<ReturnType<typeof result>>();
    const confirmations: unknown[] = [];
    let sends = 0;
    const controller = new MessageFlagsController({ onPatch: () => {}, onConfirmed: (value) => confirmations.push(value), onError: () => {} });
    const read = controller.update(message, { read: true }, () => { sends++; return first.promise; });
    const star = controller.update(message, { starred: true }, async () => { sends++; return result(true, true); });
    await Promise.resolve();
    controller.reset();
    first.resolve(result(true, false));
    await Promise.all([read, star]);
    expect(sends).toBe(1);
    expect(confirmations).toEqual([]);
  });
});
