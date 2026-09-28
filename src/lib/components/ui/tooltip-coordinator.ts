let activeTooltip: (() => void) | null = null;

export function claimTooltip(hide: () => void) {
  if (activeTooltip && activeTooltip !== hide) activeTooltip();
  activeTooltip = hide;
}

export function releaseTooltip(hide: () => void) {
  if (activeTooltip === hide) activeTooltip = null;
}
