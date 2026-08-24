import {
  RUNTIME_FIXTURE_SPECS,
  type RuntimeFixtureCase,
  type RuntimeFixtureId,
  renderRuntimeFixtureCase,
  runtimeFixtureCorrelationId
} from './runtime-fixtures';
import { DEFAULT_INBOUND_LIMITS } from '$lib/server/email';
import { InboundMimeLimitError, InboundMimeParseError, parseInboundMime } from '$lib/server/inbound/parser';

export type RuntimeMeasureFormat = 'json' | 'human';

export type RuntimeMeasureOptions = {
  ids: RuntimeFixtureId[];
  format: RuntimeMeasureFormat;
};

export const RUNTIME_PHASES = ['parser', 'd1', 'r2', 'upload', 'download', 'send_preparation'] as const;
export type RuntimePhase = (typeof RUNTIME_PHASES)[number];
export type RuntimeCloudPhaseEvidence = {
  status: 'preview_required';
  reason: string;
};
export type RuntimeParserPhaseEvidence = {
  status: 'ok' | 'error';
  wallMs: number;
  errorCategory: string | null;
  reason: string;
};
export type RuntimePhaseSummary = {
  parser: RuntimeParserPhaseEvidence;
  d1: RuntimeCloudPhaseEvidence;
  r2: RuntimeCloudPhaseEvidence;
  upload: RuntimeCloudPhaseEvidence;
  download: RuntimeCloudPhaseEvidence;
  send_preparation: RuntimeCloudPhaseEvidence;
};

type MemorySnapshot = {
  rss: number;
  heapUsed: number;
  external: number;
};

type RuntimeMeasureDependencies = {
  clock?: () => number;
  memoryUsage?: () => MemorySnapshot;
  render?: (id: RuntimeFixtureId) => RuntimeFixtureCase;
  parse?: (raw: ArrayBuffer) => Promise<unknown>;
};

export type RuntimeMeasureCase = {
  id: RuntimeFixtureId;
  correlationId: string;
  bytes: number;
  attachmentBytes: number;
  wallMs: number;
  processMemoryBytes: {
    rssBefore: number;
    rssAfter: number;
    heapUsedBefore: number;
    heapUsedAfter: number;
    externalBefore: number;
    externalAfter: number;
  };
  phases: RuntimePhaseSummary;
};

export type RuntimeMeasureReport = {
  mode: 'offline-local-harness';
  reportOnly: true;
  telemetry: 'process-memory-and-wall-time; not-Workers-isolate-telemetry';
  previewCorrelationGuide: string;
  unmeasuredTelemetry: {
    cpuTime: 'preview_required';
    isolateMemory: 'preview_required';
    subrequests: 'preview_required';
  };
  cases: RuntimeMeasureCase[];
  totals: { bytes: number; attachmentBytes: number; wallMs: number };
};

const ids = RUNTIME_FIXTURE_SPECS.map((spec) => spec.id);

function isFixtureId(value: string): value is RuntimeFixtureId {
  return ids.includes(value as RuntimeFixtureId);
}

export function parseRuntimeMeasureArgs(args: string[]): RuntimeMeasureOptions {
  let format: RuntimeMeasureFormat = 'human';
  const selected: RuntimeFixtureId[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json' || argument === '--format') {
      if (argument === '--format') {
        const value = args[++index];
        if (value !== 'json' && value !== 'human') throw new Error('--format must be json or human.');
        format = value;
      } else {
        format = 'json';
      }
      continue;
    }
    if (argument === '--case') {
      const value = args[++index];
      if (!value || !isFixtureId(value)) throw new Error(`--case must be one of: ${ids.join(', ')}.`);
      selected.push(value);
      continue;
    }
    if (argument === '--help') {
      throw new Error('Usage: bun scripts/runtime-measure.ts [--json] [--format human|json] [--case <fixture>]');
    }
    if (argument === '--remote' || argument === '--deploy' || argument === '--send') {
      throw new Error('Runtime measurement is offline/report-only and does not support remote, deploy, or send operations.');
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { ids: selected.length > 0 ? [...new Set(selected)] : ids, format };
}

function roundMillis(value: number) {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export function runtimeCorrelationId(id: RuntimeFixtureId) {
  return runtimeFixtureCorrelationId(id);
}

export function runtimePhaseSummary(parser: RuntimeParserPhaseEvidence): RuntimePhaseSummary {
  return {
    parser,
    d1: {
      status: 'preview_required',
      reason: 'No local D1 operation is executed by this report-only harness.'
    },
    r2: {
      status: 'preview_required',
      reason: 'No local R2 operation is executed by this report-only harness.'
    },
    upload: {
      status: 'preview_required',
      reason: 'No upload request is sent by this report-only harness.'
    },
    download: {
      status: 'preview_required',
      reason: 'No download request is sent by this report-only harness.'
    },
    send_preparation: {
      status: 'preview_required',
      reason: 'No provider payload or send preparation is executed by this report-only harness.'
    }
  };
}

export const RUNTIME_INBOUND_PARSE_LIMITS = Object.freeze({
  maxAttachmentCount: DEFAULT_INBOUND_LIMITS.attachmentCount,
  maxAttachmentSize: DEFAULT_INBOUND_LIMITS.attachmentBytes,
  maxAttachmentTotalSize: DEFAULT_INBOUND_LIMITS.attachmentTotalBytes
});

function parserErrorCategory(error: unknown) {
  if (error instanceof InboundMimeLimitError) return `mime_limit:${error.kind}`;
  if (error instanceof InboundMimeParseError) return 'mime_parse';
  return 'unexpected';
}

function defaultMemoryUsage(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external };
}

export async function measureRuntimeFixtures(options: RuntimeMeasureOptions, dependencies: RuntimeMeasureDependencies = {}): Promise<RuntimeMeasureReport> {
  const clock = dependencies.clock ?? (() => performance.now());
  const memoryUsage = dependencies.memoryUsage ?? defaultMemoryUsage;
  const render = dependencies.render ?? renderRuntimeFixtureCase;
  const parse = dependencies.parse ?? ((raw: ArrayBuffer) => parseInboundMime(raw, RUNTIME_INBOUND_PARSE_LIMITS));
  const cases: RuntimeMeasureCase[] = [];
  for (const id of options.ids) {
    const before = memoryUsage();
    const started = clock();
    const fixture = render(id);
    // Reading byteLength is intentional: this measures the completed local
    // fixture, while keeping the harness free of network, D1, R2, and secrets.
    const bytes = fixture.payload.byteLength;
    const parserStarted = clock();
    let parserEvidence: RuntimeParserPhaseEvidence;
    try {
      const raw = fixture.payload.slice().buffer;
      await parse(raw);
      parserEvidence = {
        status: 'ok',
        wallMs: roundMillis(clock() - parserStarted),
        errorCategory: null,
        reason: 'The production inbound MIME parser completed successfully with configured attachment limits.'
      };
    } catch (error) {
      parserEvidence = {
        status: 'error',
        wallMs: roundMillis(clock() - parserStarted),
        errorCategory: parserErrorCategory(error),
        reason: 'The production inbound MIME parser returned a controlled result; raw error details are intentionally omitted.'
      };
    }
    const ended = clock();
    const after = memoryUsage();
    cases.push({
      id,
      correlationId: runtimeCorrelationId(id),
      bytes,
      attachmentBytes: fixture.attachmentBytes,
      wallMs: roundMillis(ended - started),
      processMemoryBytes: {
        rssBefore: before.rss,
        rssAfter: after.rss,
        heapUsedBefore: before.heapUsed,
        heapUsedAfter: after.heapUsed,
        externalBefore: before.external,
        externalAfter: after.external
      },
      phases: runtimePhaseSummary(parserEvidence)
    });
  }
  return {
    mode: 'offline-local-harness',
    reportOnly: true,
    telemetry: 'process-memory-and-wall-time; not-Workers-isolate-telemetry',
    previewCorrelationGuide: 'Use each case correlationId as a marker in a controlled Preview invocation, then search that exact ID in Workers Logs or wrangler tail output. This local report does not query Preview.',
    unmeasuredTelemetry: {
      cpuTime: 'preview_required',
      isolateMemory: 'preview_required',
      subrequests: 'preview_required'
    },
    cases,
    totals: {
      bytes: cases.reduce((total, item) => total + item.bytes, 0),
      attachmentBytes: cases.reduce((total, item) => total + item.attachmentBytes, 0),
      wallMs: roundMillis(cases.reduce((total, item) => total + item.wallMs, 0))
    }
  };
}

export function formatRuntimeMeasureHuman(report: RuntimeMeasureReport) {
  const lines = [
    'FlareMail runtime measurement (offline local harness; report-only)',
    'Telemetry: process memory and wall time only; not Workers isolate telemetry.',
    'Preview mapping: use each correlation ID in a controlled Preview invocation, then search it in Workers Logs or wrangler tail. CPU time, isolate memory, and subrequest counts are preview-required.'
  ];
  for (const item of report.cases) {
    const phases = RUNTIME_PHASES.filter((phase) => phase !== 'parser').map((phase) => `${phase}=${item.phases[phase].status}`).join(',');
    const parser = item.phases.parser;
    lines.push(`${item.id} [${item.correlationId}]: ${item.bytes} bytes, ${item.attachmentBytes} decoded attachment bytes, ${item.wallMs.toFixed(3)} ms, rss ${item.processMemoryBytes.rssBefore}->${item.processMemoryBytes.rssAfter} bytes, parser=${parser.status}/${parser.wallMs.toFixed(3)}ms/${parser.errorCategory ?? 'none'}, phases parser=${parser.status},${phases}`);
  }
  lines.push(`total: ${report.totals.bytes} bytes, ${report.totals.attachmentBytes} decoded attachment bytes, ${report.totals.wallMs.toFixed(3)} ms`);
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    const options = parseRuntimeMeasureArgs(process.argv.slice(2));
    const report = await measureRuntimeFixtures(options);
    console.log(options.format === 'json' ? JSON.stringify(report, null, 2) : formatRuntimeMeasureHuman(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime measurement failed.');
    process.exit(1);
  }
}
