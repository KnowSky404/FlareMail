import { expect, test } from 'bun:test';
import { claimTooltip, releaseTooltip } from './tooltip-coordinator';

test('only the most recently claimed tooltip remains active', () => {
  let firstHidden = 0;
  let secondHidden = 0;
  const first = () => { firstHidden += 1; releaseTooltip(first); };
  const second = () => { secondHidden += 1; releaseTooltip(second); };
  const third = () => { releaseTooltip(third); };

  claimTooltip(first);
  claimTooltip(second);
  expect(firstHidden).toBe(1);
  releaseTooltip(first);
  claimTooltip(third);
  expect(secondHidden).toBe(1);
  releaseTooltip(third);
});
