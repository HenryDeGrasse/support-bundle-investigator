import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  writeProvenanceFile: vi.fn(),
}));

import { parseArgs } from '../cli.js';
import { analyzeBundlePipeline, cleanupPipelineResult } from '../../pipeline/analyze.js';
import { writePipelineResult, writeTraceFile, writeProvenanceFile } from '../output.js';
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
    findingTree: [],
    graph: { nodes: new Map(), edges: [] } as unknown as PipelineResult['graph'],
    trace: {
      bundlePath: '/tmp/bundle.tar.gz',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: [],
    } as PipelineResult['trace'],
    aiMode: 'off',
  };
}

describe('runCli()', () => {
  const parseArgsMock = vi.mocked(parseArgs);
  const analyzeBundlePipelineMock = vi.mocked(analyzeBundlePipeline);
  const cleanupPipelineResultMock = vi.mocked(cleanupPipelineResult);
  const writePipelineResultMock = vi.mocked(writePipelineResult);
  const writeTraceFileMock = vi.mocked(writeTraceFile);
  const writeProvenanceFileMock = vi.mocked(writeProvenanceFile);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleans up extracted artifacts after a successful run', async () => {
    const result = makePipelineResult();

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'markdown',
      outputDir: '/tmp/out',
      verbose: false,
      trace: true,
      debug: false,
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
      debug: false,
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
      debug: false,
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
      debug: false,
      noAi: true,
    });
  });

  it('forces verbose and trace, writes trace.json and provenance.json, and logs debug summary when --debug is set', async () => {
    const result = makePipelineResult();
    result.findings = [
      {
        id: 'finding:ai:0',
        title: 'Root cause',
        severity: 'high',
        confidence: 0.8,
        affectedComponents: ['Pod/default/api'],
        reasoningSummary: 'AI finding',
        evidence: [{ path: 'cluster-resources/pods/default/api.yaml', note: 'evidence' }],
        contradictionsChecked: [],
        recommendedAction: 'Investigate',
        missingEvidence: [],
        provenance: {
          investigator: 'ai',
          seedId: 'seed:merged:1',
          generatedAt: new Date().toISOString(),
          mergedFrom: ['finding:k8s:1'],
          confidenceDelta: 0.15,
        },
      },
    ];

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'json',
      outputDir: '/tmp/out',
      verbose: false,
      trace: false,
      debug: true,
      noAi: false,
      tui: false,
    });
    analyzeBundlePipelineMock.mockResolvedValue(result);
    writePipelineResultMock.mockResolvedValue();
    writeTraceFileMock.mockResolvedValue();
    writeProvenanceFileMock.mockResolvedValue();
    cleanupPipelineResultMock.mockResolvedValue();

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--debug'])).resolves.toBe(0);

    expect(analyzeBundlePipelineMock).toHaveBeenCalledWith('/tmp/bundle.tar.gz', {
      outputDir: '/tmp/out',
      verbose: true,
      trace: true,
      debug: true,
      noAi: false,
    });
    expect(writePipelineResultMock).toHaveBeenCalledWith(result, {
      format: 'json',
      outputDir: '/tmp/out',
      verbose: true,
      debug: true,
    });
    expect(writeTraceFileMock).toHaveBeenCalledWith(result.trace, '/tmp/out');
    expect(writeProvenanceFileMock).toHaveBeenCalledWith(result.findings, '/tmp/out');
    expect(console.error).toHaveBeenCalledWith('Debug finding provenance summary');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('finding:ai:0'));
  });

  it('still cleans up extracted artifacts when report writing fails', async () => {
    const result = makePipelineResult();

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'html',
      outputDir: '/tmp/out',
      verbose: true,
      trace: false,
      debug: false,
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

  it('routes verbose pipeline diagnostics to stderr without contaminating stdout', async () => {
    const result = makePipelineResult();
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    analyzeBundlePipelineMock.mockImplementation(async () => {
      console.log('pipeline diagnostic');
      return result;
    });
    writePipelineResultMock.mockImplementation(async () => {
      console.log('{"findings":[]}');
    });
    cleanupPipelineResultMock.mockResolvedValue();
    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'json',
      outputDir: undefined,
      verbose: true,
      trace: false,
      debug: false,
      noAi: false,
      tui: false,
    });

    await expect(runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz'])).resolves.toBe(0);

    expect(console.error).toHaveBeenCalledWith('pipeline diagnostic');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith('{"findings":[]}');
  });

  // ── TUI mode tests ────────────────────────────────────────────────────────

  it('calls renderTUI with correct args when --tui flag is set and loadTUI is provided', async () => {
    const renderTUIMock = vi.fn().mockResolvedValue({ ok: true });
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });

    const options: RunCliOptions = {
      loadTUI: loadTUIMock,
      isInteractiveTerminal: () => true,
    };

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: '/tmp/out',
      verbose: false,
      trace: false,
      debug: false,
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
      debug: false,
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
      debug: false,
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
      debug: false,
      noAi: true,
      tui: true,
    });

    await expect(
      runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], {
        loadTUI: loadTUIMock,
        isInteractiveTerminal: () => true,
      }),
    ).resolves.toBe(1);

    expect(loadTUIMock).toHaveBeenCalledOnce();
    expect(renderTUIMock).toHaveBeenCalledWith('/tmp/bundle.tar.gz', {
      outputDir: '/tmp/out',
      verbose: true,
      noAi: true,
      trace: true,
      debug: false,
    });
    expect(console.error).toHaveBeenCalledWith('Error:', 'tui failed');
    expect(analyzeBundlePipelineMock).not.toHaveBeenCalled();
    expect(cleanupPipelineResultMock).not.toHaveBeenCalled();
  });

  it('fails fast without loading the TUI when the terminal is non-interactive', async () => {
    const loadTUIMock = vi.fn();
    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      debug: false,
      noAi: false,
      tui: true,
    });

    await expect(
      runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], {
        loadTUI: loadTUIMock,
        isInteractiveTerminal: () => false,
      }),
    ).resolves.toBe(1);

    expect(loadTUIMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Error: --tui requires an interactive terminal.');
  });

  it('propagates a rendered TUI pipeline failure as a nonzero exit', async () => {
    const renderTUIMock = vi.fn().mockResolvedValue({ ok: false, error: 'analysis failed' });
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });
    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      debug: false,
      noAi: false,
      tui: true,
    });

    await expect(
      runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], {
        loadTUI: loadTUIMock,
        isInteractiveTerminal: () => true,
      }),
    ).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith('Error:', 'analysis failed');
  });

  it('uses the conventional SIGINT exit code for TUI cancellation', async () => {
    const renderTUIMock = vi.fn().mockResolvedValue({ ok: false, cancelled: true });
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });
    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      debug: false,
      noAi: false,
      tui: true,
    });

    await expect(
      runCli(['node', 'sbi', 'analyze', '/tmp/bundle.tar.gz', '--tui'], {
        loadTUI: loadTUIMock,
        isInteractiveTerminal: () => true,
      }),
    ).resolves.toBe(130);
  });

  it('runs the standard pipeline path when tui is false, even if loadTUI is provided', async () => {
    const result = makePipelineResult();
    const renderTUIMock = vi.fn().mockResolvedValue({ ok: true });
    const loadTUIMock = vi.fn().mockResolvedValue({ renderTUI: renderTUIMock });

    const options: RunCliOptions = { loadTUI: loadTUIMock };

    parseArgsMock.mockReturnValue({
      bundlePath: '/tmp/bundle.tar.gz',
      format: 'text',
      outputDir: undefined,
      verbose: false,
      trace: false,
      debug: false,
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
