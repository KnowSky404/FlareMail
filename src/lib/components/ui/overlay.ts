type OverlayToken = object;

const overlayStack: OverlayToken[] = [];
let originalBodyOverflow = '';

export function registerOverlay(token: OverlayToken) {
  if (typeof document === 'undefined') return () => undefined;

  if (overlayStack.length === 0) {
    originalBodyOverflow = document.body.style.overflow;
  }
  overlayStack.push(token);
  document.body.style.overflow = 'hidden';

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const index = overlayStack.lastIndexOf(token);
    if (index >= 0) overlayStack.splice(index, 1);
    if (overlayStack.length === 0) {
      document.body.style.overflow = originalBodyOverflow;
      originalBodyOverflow = '';
    }
  };
}

export function isTopOverlay(token: OverlayToken) {
  return overlayStack.at(-1) === token;
}
