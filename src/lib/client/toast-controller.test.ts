import { describe, expect, test } from 'bun:test';
import { ToastController, type ToastMessage } from './toast-controller';

describe('ToastController', () => {
  test('publishes typed messages and invokes one-shot actions', async () => {
    let current: ToastMessage[] = [];
    let invoked = 0;
    const controller = new ToastController((messages) => (current = messages));
    const id = controller.push({ tone: 'warning', message: 'Moved to trash.', persistent: true,
      action: { label: 'Undo', run: () => { invoked += 1; } } });
    expect(current).toEqual([expect.objectContaining({ id, tone: 'warning', actionLabel: 'Undo', persistent: true })]);
    await controller.invoke(id);
    expect(invoked).toBe(1);
    expect(current).toEqual([]);
  });

  test('keeps the region bounded and clears evicted actions', async () => {
    let current: ToastMessage[] = [];
    let evictedInvocations = 0;
    const controller = new ToastController((messages) => (current = messages));
    const evictedId = controller.push({
      tone: 'info',
      message: 'evicted',
      persistent: true,
      action: { label: 'Undo', run: () => { evictedInvocations += 1; } }
    });
    for (let index = 0; index < 6; index += 1) {
      controller.push({ tone: 'info', message: String(index), persistent: true });
    }
    expect(current.map(({ message }) => message)).toEqual(['2', '3', '4', '5']);
    await controller.invoke(evictedId);
    expect(evictedInvocations).toBe(0);
    controller.reset();
    expect(current).toEqual([]);
  });
});
