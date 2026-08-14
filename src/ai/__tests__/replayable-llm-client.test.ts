import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CassetteRecorder, cassetteSeedKey } from '../recorder.js';
import { ReplayableLLMClient } from '../replayable-llm-client.js';
import type { InvestigationLLMClient } from '../llm-client.js';

const VALID_FINDING = {
  title: 'CrashLoopBackOff: Pod app-pod',
  severity: 'critical' as const,
  confidence: 0.9,
  affectedComponents: ['Pod/default/app-pod'],
  reasoningSummary: 'Pod app-pod is restarting repeatedly.',
  evidence: [{ path: 'cluster-resources/pods/default/app-pod.yaml', note: 'CrashLoopBackOff' }],
  contradictionsChecked: [],
  recommendedAction: 'Inspect logs.',
  missingEvidence: [],
};

function makeInnerClient() {
  return {
    investigateSeed: vi.fn().mockResolvedValue({
      findings: [VALID_FINDING],
      rawResponse: JSON.stringify({ findings: [VALID_FINDING] }),
    }),
    generateText: vi.fn().mockResolvedValue('generated text'),
    getModel: vi.fn().mockReturnValue('gpt-4o'),
  } satisfies InvestigationLLMClient & { getModel: () => string };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-replayable-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ReplayableLLMClient', () => {
  it('records responses in record mode and delegates to the inner client', async () => {
    const inner = makeInnerClient();
    const recorder = new CassetteRecorder('record', tmpDir);
    const client = new ReplayableLLMClient(inner, recorder, () => ({
      seedId: 'fallback-seed',
      seedCategory: 'kubernetes',
    }));

    client.setSeedContext('seed:k8s:0', 'kubernetes');
    const result = await client.investigateSeed('system prompt', 'user prompt');

    expect(inner.investigateSeed).toHaveBeenCalledWith('system prompt', 'user prompt');
    expect(result.findings).toHaveLength(1);
    expect(recorder.has('seed:k8s:0', 'kubernetes')).toBe(true);

    const request = { system: 'system prompt', user: 'user prompt' };
    const cassette = recorder.replay(
      'seed:k8s:0',
      'kubernetes',
      request,
      'gpt-4o',
    );
    expect(cassette?.seedKey).toBe(
      cassetteSeedKey('seed:k8s:0', 'kubernetes', request, 'gpt-4o'),
    );
    expect(cassette?.response.findings[0]?.title).toBe(VALID_FINDING.title);
    expect(cassette?.model).toBe('gpt-4o');
  });

  it('exposes the wrapped model via getModel', () => {
    const inner = makeInnerClient();
    const client = new ReplayableLLMClient(
      inner,
      new CassetteRecorder('live', tmpDir),
      () => ({ seedId: 'seed:k8s:model', seedCategory: 'kubernetes' }),
    );

    expect(client.getModel()).toBe('gpt-4o');
  });

  it('replays cached responses without calling the inner client', async () => {
    const recordRecorder = new CassetteRecorder('record', tmpDir);
    recordRecorder.record(
      'seed:k8s:1',
      'kubernetes',
      { system: 'system prompt', user: 'user prompt' },
      { findings: [VALID_FINDING], rawResponse: JSON.stringify({ findings: [VALID_FINDING] }) },
      'gpt-4o',
    );
    await recordRecorder.flush();

    const replayRecorder = new CassetteRecorder('replay', tmpDir);
    await replayRecorder.load();

    const inner = makeInnerClient();
    const client = new ReplayableLLMClient(inner, replayRecorder, () => ({
      seedId: 'seed:k8s:1',
      seedCategory: 'kubernetes',
    }));

    client.setSeedContext('seed:k8s:1', 'kubernetes');
    const result = await client.investigateSeed('system prompt', 'user prompt');

    expect(result.findings).toHaveLength(1);
    expect(result.rawResponse).toContain('CrashLoopBackOff');
    expect(inner.investigateSeed).not.toHaveBeenCalled();
  });

  it('degrades gracefully for missing replay cassettes and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recorder = new CassetteRecorder('replay', tmpDir);
    await recorder.load();

    const inner = makeInnerClient();
    const client = new ReplayableLLMClient(inner, recorder, () => ({
      seedId: 'seed:k8s:missing',
      seedCategory: 'kubernetes',
    }));

    client.setSeedContext('seed:k8s:missing', 'kubernetes');
    const result = await client.investigateSeed('system prompt', 'user prompt');

    expect(result).toMatchObject({
      findings: [],
      rawResponse: undefined,
      telemetry: {
        model: 'gpt-4o',
        latencyMs: 0,
        success: false,
      },
    });
    expect(inner.investigateSeed).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('seed:k8s:missing'),
    );
  });

  it('passes through unchanged in live mode', async () => {
    const inner = makeInnerClient();
    const recorder = new CassetteRecorder('live', tmpDir);
    const client = new ReplayableLLMClient(inner, recorder, () => ({
      seedId: 'seed:k8s:2',
      seedCategory: 'kubernetes',
    }));

    const result = await client.investigateSeed('system prompt', 'user prompt');

    expect(result.findings).toHaveLength(1);
    expect(inner.investigateSeed).toHaveBeenCalledTimes(1);
    expect(recorder.size).toBe(0);
  });

  it('returns an empty string for generateText in replay mode', async () => {
    const inner = makeInnerClient();
    const recorder = new CassetteRecorder('replay', tmpDir);
    const client = new ReplayableLLMClient(inner, recorder, () => ({
      seedId: 'seed:k8s:3',
      seedCategory: 'kubernetes',
    }));

    await expect(client.generateText('system prompt', 'user prompt')).resolves.toBe('');
    expect(inner.generateText).not.toHaveBeenCalled();
  });

  it('delegates generateText in record and live modes', async () => {
    const recordInner = makeInnerClient();
    const recordClient = new ReplayableLLMClient(
      recordInner,
      new CassetteRecorder('record', tmpDir),
      () => ({ seedId: 'seed:k8s:4', seedCategory: 'kubernetes' }),
    );
    await expect(recordClient.generateText('system prompt', 'user prompt')).resolves.toBe('generated text');
    expect(recordInner.generateText).toHaveBeenCalledWith('system prompt', 'user prompt');

    const liveInner = makeInnerClient();
    const liveClient = new ReplayableLLMClient(
      liveInner,
      new CassetteRecorder('live', tmpDir),
      () => ({ seedId: 'seed:k8s:5', seedCategory: 'kubernetes' }),
    );
    await expect(liveClient.generateText('system prompt', 'user prompt')).resolves.toBe('generated text');
    expect(liveInner.generateText).toHaveBeenCalledWith('system prompt', 'user prompt');
  });
});
