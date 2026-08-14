import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import type { PipelineResult } from '../../pipeline/analyze.js';

vi.mock('../../cli/output.js', () => ({
  writePipelineResult: vi.fn(),
  writeTraceFile: vi.fn(),
  writeProvenanceFile: vi.fn(),
}));

import {
  writePipelineResult,
  writeTraceFile,
  writeProvenanceFile,
} from '../../cli/output.js';
import { App } from '../components/App.js';

function makePipelineResult(): PipelineResult {
  const now = new Date().toISOString();
  return {
    profile: {
      manifest: {
        bundlePath: '/tmp/bundle.tar.gz',
        extractedPath: '/tmp/sbi-bundle-tui-test',
        files: [],
        totalSize: 0,
        extractedAt: new Date(),
      },
      analyzerCount: 0,
      resourceCount: 0,
      eventCount: 0,
      logFileCount: 0,
      namespaces: [],
      workloads: [],
      coverageGaps: [],
      artifactsByCategory: {
        analyzer: 0,
        log: 0,
        'kubernetes-resource': 0,
        event: 0,
        'cluster-info': 0,
        'helm-release': 0,
        unknown: 0,
      },
    },
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [],
    findings: [],
    findingTree: [],
    graph: { nodes: new Map(), edges: [] } as unknown as PipelineResult['graph'],
    trace: {
      bundlePath: '/tmp/bundle.tar.gz',
      startedAt: now,
      completedAt: now,
      steps: [],
    } as PipelineResult['trace'],
    aiMode: 'off',
  };
}

function makeTerminal(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  input: PassThrough;
  readOutput: () => string;
} {
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });

  const output = new PassThrough();
  Object.assign(output, { columns: 120, rows: 40 });
  let renderedOutput = '';
  output.on('data', (chunk: Buffer | string) => {
    renderedOutput += chunk.toString();
  });

  const error = new PassThrough();
  error.resume();

  return {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: error as unknown as NodeJS.WriteStream,
    input,
    readOutput: () => renderedOutput,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for TUI state');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('App lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writePipelineResult).mockResolvedValue();
    vi.mocked(writeTraceFile).mockResolvedValue();
    vi.mocked(writeProvenanceFile).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports cancellation and still cleans a result that finishes after unmount', async () => {
    const terminal = makeTerminal();
    const result = makePipelineResult();
    let finishPipeline!: (value: PipelineResult) => void;
    const runPipeline = vi.fn(() => new Promise<PipelineResult>((resolve) => {
      finishPipeline = resolve;
    }));
    const cleanupPipeline = vi.fn().mockResolvedValue(undefined);
    const onOutcome = vi.fn();
    const instance = render(
      React.createElement(App, {
        bundlePath: '/tmp/bundle.tar.gz',
        runPipeline,
        cleanupPipeline,
        onOutcome,
      }),
      { ...terminal, exitOnCtrlC: false, patchConsole: false },
    );

    await waitFor(() => runPipeline.mock.calls.length === 1);
    terminal.input.write('q');
    await instance.waitUntilExit();
    expect(onOutcome).toHaveBeenCalledWith({ ok: false, cancelled: true });

    finishPipeline(result);
    await waitFor(() => cleanupPipeline.mock.calls.length === 1);
    expect(cleanupPipeline).toHaveBeenCalledWith(result);
  });

  it('reports a pipeline error before the user dismisses the error screen', async () => {
    const terminal = makeTerminal();
    const onOutcome = vi.fn();
    const instance = render(
      React.createElement(App, {
        bundlePath: '/tmp/bundle.tar.gz',
        runPipeline: vi.fn().mockRejectedValue(new Error('pipeline exploded')),
        onOutcome,
      }),
      { ...terminal, exitOnCtrlC: false, patchConsole: false },
    );

    await waitFor(() => onOutcome.mock.calls.length === 1);
    expect(onOutcome).toHaveBeenCalledWith({ ok: false, error: 'pipeline exploded' });
    terminal.input.write('q');
    await instance.waitUntilExit();
  });

  it(
    'exports trace and provenance artifacts in debug mode',
    async () => {
      const terminal = makeTerminal();
      const result = makePipelineResult();
      const cleanupPipeline = vi.fn().mockResolvedValue(undefined);
      const instance = render(
        React.createElement(App, {
          bundlePath: '/tmp/bundle.tar.gz',
          outputDir: '/tmp/tui-output',
          pipelineOptions: { verbose: true, trace: true, debug: true },
          runPipeline: vi.fn().mockResolvedValue(result),
          cleanupPipeline,
        }),
        { ...terminal, exitOnCtrlC: false, patchConsole: false },
      );

      // Ink rendering shares the Vitest worker with the full integration suite
      // in CI. Wait for an observable ready frame instead of assuming it will
      // commit within one second on a contended runner.
      await waitFor(
        () =>
          cleanupPipeline.mock.calls.length === 1 &&
          terminal.readOutput().includes('Findings'),
      );
      terminal.input.write('s');
      await waitFor(() => vi.mocked(writeProvenanceFile).mock.calls.length === 1);

      expect(writePipelineResult).toHaveBeenCalledWith(result, {
        format: 'json',
        outputDir: '/tmp/tui-output',
        verbose: false,
        debug: true,
      });
      expect(writeTraceFile).toHaveBeenCalledWith(result.trace, '/tmp/tui-output');
      expect(writeProvenanceFile).toHaveBeenCalledWith(result.findings, '/tmp/tui-output');

      terminal.input.write('q');
      await instance.waitUntilExit();
    },
    15_000,
  );
});
