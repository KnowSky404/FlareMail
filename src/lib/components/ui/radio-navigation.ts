/** Return the next radio index for a non-toolbar radiogroup, or null for unrelated keys. */
export function nextRadioIndex(key: string, currentIndex: number, count: number): number | null {
  if (currentIndex < 0 || count < 1) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
