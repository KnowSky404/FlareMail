import { describe, expect, test } from 'bun:test';
import {
  formatRuntimeMeasureHuman,
  measureRuntimeFixtures,
  parseRuntimeMeasureArgs,
  RUNTIME_PHASES,
  runtimeCorrelationId
} from './runtime-measure';

describe('runtime measurement harness', () => {
  test('defaults to every fixture and offline human output', () => {
    const options = parseRuntimeMeasureArgs([]);
    expect(options.format).toBe('human');
    expect(options.ids).toContain('runtime-1MiB');
    expect(options.ids).toContain('attachments-near-total-cap');
  });

  test('supports stable JSON-shaped report-only output with injected measurements', async () => {
    const options = parseRuntimeMeasureArgs(['--json', '--case', 'multiple-attachments']);
    let clockValue = 10;
    let memoryValue = 100;
    const report = await measureRuntimeFixtures(options, {
      clock: () => {
        clockValue += 2.3456;
        return clockValue;
      },
      memoryUsage: () => {
        memoryValue += 100;
        return { rss: memoryValue, heapUsed: memoryValue + 1, external: memoryValue + 2 };
      },
      parse: async () => undefined
    });
    expect(report.mode).toBe('offline-local-harness');
    expect(report.reportOnly).toBe(true);
    expect(report.telemetry).toContain('not-Workers-isolate-telemetry');
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]?.correlationId).toBe(runtimeCorrelationId('multiple-attachments'));
    expect(Object.keys(report.cases[0]?.phases ?? {})).toEqual([...RUNTIME_PHASES]);
    expect(report.cases[0]?.phases.parser.status).toBe('ok');
    expect(report.cases[0]?.phases.d1.status).toBe('preview_required');
    expect(report.cases[0]?.phases.r2.status).toBe('preview_required');
    expect(report.cases[0]?.phases.upload.status).toBe('preview_required');
    expect(report.cases[0]?.phases.download.status).toBe('preview_required');
    expect(report.cases[0]?.phases.send_preparation.status).toBe('preview_required');
    expect(report.previewCorrelationGuide).toContain('Workers Logs');
    expect(report.previewCorrelationGuide).toContain('wrangler tail');
    expect(report.unmeasuredTelemetry).toEqual({
      cpuTime: 'preview_required',
      isolateMemory: 'preview_required',
      subrequests: 'preview_required'
    });
    expect(report.cases[0]?.wallMs).toBe(7.037);
    expect(report.cases[0]?.phases.parser).toMatchObject({ status: 'ok', wallMs: 2.346, errorCategory: null });
    expect(report.cases[0]?.bytes).toBeGreaterThan(0);
    expect(report.totals).toEqual({
      bytes: report.cases[0]?.bytes,
      attachmentBytes: report.cases[0]?.attachmentBytes,
      wallMs: 7.037
    });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(JSON.stringify(report)).not.toContain('API_KEY');
    expect(JSON.stringify(report)).not.toMatch(/"cpuTime":\d/u);
    expect(JSON.stringify(report)).not.toMatch(/"isolateMemory":\d/u);
    expect(JSON.stringify(report)).not.toMatch(/"subrequests":\d/u);
  });

  test('rejects remote or destructive options', () => {
    expect(() => parseRuntimeMeasureArgs(['--remote'])).toThrow('offline/report-only');
    expect(() => parseRuntimeMeasureArgs(['--deploy'])).toThrow('offline/report-only');
    expect(() => parseRuntimeMeasureArgs(['--send'])).toThrow('offline/report-only');
  });

  test('measures the production inbound parser with bounded fixture limits', async () => {
    const report = await measureRuntimeFixtures(parseRuntimeMeasureArgs(['--case', 'html-cid']));
    expect(report.cases[0]?.phases.parser.status).toBe('ok');
    expect(report.cases[0]?.phases.parser.wallMs).toBeGreaterThanOrEqual(0);
    expect(report.cases[0]?.phases.parser.errorCategory).toBeNull();
    expect(report.cases[0]?.phases.d1.status).toBe('preview_required');
  });

  test('human output labels local harness evidence and preserves bounded fields', async () => {
    const report = await measureRuntimeFixtures(parseRuntimeMeasureArgs(['--case', 'content-length-mismatch']), {
      clock: (() => {
        let value = 0;
        return () => (value += 1);
      })(),
      memoryUsage: () => ({ rss: 1, heapUsed: 2, external: 3 }),
      parse: async () => undefined
    });
    const output = formatRuntimeMeasureHuman(report);
    expect(output).toContain('offline local harness; report-only');
    expect(output).toContain('not Workers isolate telemetry');
    expect(output).toContain('content-length-mismatch');
    expect(output).toContain('flaremail-rc1-content-length-mismatch');
    expect(output).toContain('parser=ok');
    expect(output).toContain('d1=preview_required');
    expect(output).toContain('wrangler tail');
    expect(output).not.toContain('Content-Length:');
  });
});
