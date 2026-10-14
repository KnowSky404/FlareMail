import { tick } from 'svelte';

function scrollContainer(element: HTMLElement | undefined): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll)$/u.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** Preserve visited-page positions without scrolling a newly selected view. */
export function createPageScroll() {
  const positions = new Map<string, number>();
  return async (element: HTMLElement | undefined, context: string, page: number,
    load: () => Promise<boolean>, currentPage: () => number, currentContext: () => string = () => context) => {
    const container = scrollContainer(element);
    if (!container) return load();
    positions.set(`${context}:${page}`, container.scrollTop);
    while (positions.size > 32) positions.delete(positions.keys().next().value!);
    if (!await load()) return false;
    await tick();
    const next = currentPage();
    if (element?.isConnected && currentContext() === context && next !== page) container.scrollTop = next < page ? positions.get(`${context}:${next}`) ?? 0 : 0;
    return true;
  };
}
