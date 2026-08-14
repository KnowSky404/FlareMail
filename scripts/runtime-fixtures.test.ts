import { describe, expect, test } from 'bun:test';
import { renderRuntimeFixture, RUNTIME_FIXTURE_SIZES } from './runtime-fixtures';

describe('runtime MIME fixtures', () => {
  test('renders deterministic RFC MIME payloads at the requested sizes', () => {
    const first = renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.oneMiB);
    const second = renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.oneMiB);
    expect(first.byteLength).toBe(1 * 1024 * 1024);
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first.slice(0, 400))).toContain('Content-Type: text/plain');
  });
});
