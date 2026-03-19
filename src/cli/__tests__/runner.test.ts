import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommanderError } from '../cli.js';
import type { PipelineResult } from '../../pipeline/analyze.js';
import type { RunCliOptions } from '../runner.js';

vi.mock('../cli.js', async () => {
  const actual = await vi.importActual<typeof import('../cli.js')>('../cli.js');
  return {
    ...actual,
    parseArgs: vi.fn(),
  };
});

vi.mock('../../pipeline/analyze.js', () => ({
  analyzeBundlePipeline: vi.fn(),
  cleanupPipelineResult: vi.fn(),
}));

vi.mock('../output.js', () => ({
  writePipelineResult: vi.fn(),
  writeTraceFile: vi.fn(),
}));

import { parseArgs } from '../cli.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../pipeline/analyze.js';
import { writePipelineResult, writeTraceFile } from '../output.js';
import { runCli } from '../runner.js';

function makePipelineResult(): PipelineResult {
  return {
    profile: {
      manifest: {
        bundlePath: '/tmp/bundle.tar.gz',
        extractedPath: '/tmp/sbi-bundle-test',
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
    graph: { nodes: new Map(), edges: [] } as unknown as PipelineResult['graph'],
    trace: {
      bundlePath: '/tmp/bundle.tar.gz',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: [],
    } as PipelineResult['trace'],
  };
}

describe('runCli()', () => {
  const parseArgsMock = vi.mocked(parseArgs);
  const analyzeBundlePipelineMock = vi.mocked(analyzeBundlePipeline);
  const cleanupPipelineResultMock = vi.mocked(cleanupPipelineResult);
  const writePipelineResultMock = vi.mocked(writePipelineResult);
  const writeTraceFileMock = vi.mocked(writeTraceFile);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('cleans up extracted artifacts after a successful run', async () => {
    const result = makePipelineResult();

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'markdown',
      outputDir: '/tmp/out',
      verbose: false,
      trace: true,
      noAi: false,
      tui: false,
    });
    analyzeBundlePipelineMock.mockResolvedValue(result);
    writePipelineResultMock.mockResolvedValue();
    writeTraceFileMock.mockResolvedValue();
    cleanupPipelineResultMock.mockResolvedValue();

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz'])).resolves.toBe(0);

    expect(writePipelineResultMock).toHaveBeenCalledWith(result, {
      format: 'markdown',
      outputDir: '/tmp/out',
      verbose: false,
    });
    expect(writeTraceFileMock).toHaveBeenCalledWith(result.trace, '/tmp/out');
    expect(cleanupPipelineResultMock).toHaveBeenCalledWith(result);
  });

  it('passes the --no-ai flag through to the pipeline', async () => {
    const result = makePipelineResult();

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      noAi: true,
      tui: false,
    });
    analyzeBundlePipelineMock.mockResolvedValue(result);
    writePipelineResultMock.mockResolvedValue();
    cleanupPipelineResultMock.mockResolvedValue();

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--no-ai'])).resolves.toBe(0);

    expect(analyzeBundlePipelineMock).toHaveBeenCalledWith('/tmp/bundle.tar.gz', {
      outputDir: undefined,
      verbose: false,
      trace: false,
      noAi: true,
    });
  });

  it('still cleans up extracted artifacts when report writing fails', async () => {
    const result = makePipelineResult();

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'html',
      outputDir: '/tmp/out',
      verbose: true,
      trace: false,
      noAi: false,
      tui: false,
    });
    analyzeBundlePipelineMock.mockResolvedValue(result);
    writePipelineResultMock.mockRejectedValue(new Error('disk full'));
    cleanupPipelineResultMock.mockResolvedValue();

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz'])).resolves.toBe(1);

    expect(cleanupPipelineResultMock).toHaveBeenCalledWith(result);
    expect(writeTraceFileMock).not.toHaveBeenCalled();
  });

  it('does not attempt cleanup when argument parsing exits early', async () => {
    parseArgsMock.mockImplementation(() => {
      throw new CommanderError(0, 'commander.helpDisplayed', 'help displayed');
    });

    await expect(runCli(['node', 'sbi', 'analyze', '--help'])).resolves.toBe(0);

    expect(analyzeBundlePipelineMock).not.toHaveBeenCalled();
    expect(cleanupPipelineResultMock).not.toHaveBeenCalled();
  });

  // ── TUI mode tests ────────────────────────────────────────────────────────

  it('calls renderTUI with correct args when --tui flag is set and loadTUI is provided', async () => {
    const renderTUIMock = vi.fn().mockResolvedValue(undefined);
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });

    const options: RunCliOptions = { loadTUI: loadTUIMock };

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: '/tmp/out',
      verbose: false,
      trace: false,
      noAi: false,
      tui: true,
    });

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], options)).resolves.toBe(0);

    expect(loadTUIMock).toHaveBeenCalledOnce();
    expect(renderTUIMock).toHaveBeenCalledWith('/tmp/bundle.tar.gz', {
      outputDir: '/tmp/out',
      verbose: false,
      noAi: false,
      trace: false,
    });
    // Pipeline should NOT run in TUI mode
    expect(analyzeBundlePipelineMock).not.toHaveBeenCalled();
    expect(cleanupPipelineResultMock).not.toHaveBeenCalled();
  });

  it('returns 1 and prints error when --tui is set but no loadTUI is provided', async () => {
    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      noAi: false,
      tui: true,
    });

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'])).resolves.toBe(1);

    expect(console.error).toHaveBeenCalledWith(
      'Error: --tui is only supported when running via the sbi CLI binary.',
    );
    expect(analyzeBundlePipelineMock).not.toHaveBeenCalled();
  });

  it('returns 1 when loading or rendering the TUI fails', async () => {
    const renderTUIMock = vi.fn().mockRejectedValue(new Error('tui failed'));
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: '/tmp/out',
      verbose: true,
      trace: true,
      noAi: true,
      tui: true,
    });

    await expect(
      runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], { loadTUI: loadTUIMock }),
    ).resolves.toBe(1);

    expect(loadTUIMock).toHaveBeenCalledOnce();
    expect(renderTUIMock).toHaveBeenCalledWith('/tmp/bundle.tar.gz', {
      outputDir: '/tmp/out',
      verbose: true,
      noAi: true,
      trace: true,
    });
    expect(console.error).toHaveBeenCalledWith('Error:', 'tui failed');
    expect(analyzeBundlePipelineMock).not.toHaveBeenCalled();
    expect(cleanupPipelineResultMock).not.toHaveBeenCalled();
  });

  it('runs the standard pipeline path when tui is false, even if loadTUI is provided', async () => {
    const result = makePipelineResult();
    const renderTUIMock = vi.fn().mockResolvedValue(undefined);
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });

    const options: RunCliOptions = { loadTUI: loadTUIMock };

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      noAi: false,
      tui: false,
    });
    analyzeBundlePipelineMock.mockResolvedValue(result);
    writePipelineResultMock.mockResolvedValue();
    cleanupPipelineResultMock.mockResolvedValue();

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz'], options)).resolves.toBe(0);

    expect(loadTUIMock).not.toHaveBeenCalled();
    expect(renderTUIMock).not.toHaveBeenCalled();
    expect(analyzeBundlePipelineMock).toHaveBeenCalledOnce();
  });
});
