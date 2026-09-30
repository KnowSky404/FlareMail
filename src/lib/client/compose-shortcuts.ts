type ComposeKeyEvent = Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented'
> & { keyCode?: number };

function isFreshKey(event: ComposeKeyEvent) {
  // Safari can report the final IME Enter as keyCode 229 without isComposing.
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat;
}

export function isComposeSendShortcut(event: ComposeKeyEvent) {
  return isFreshKey(event) && event.key === 'Enter' && (event.ctrlKey || event.metaKey)
    && !event.altKey && !event.shiftKey;
}

/** Recipient selection must never consume a send shortcut or an IME candidate key. */
export function shouldHandleRecipientKey(event: ComposeKeyEvent) {
  return isFreshKey(event) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function isRecipientCommitKey(event: ComposeKeyEvent) {
  return shouldHandleRecipientKey(event) && ['Enter', ',', '，', ';', '；'].includes(event.key);
}
