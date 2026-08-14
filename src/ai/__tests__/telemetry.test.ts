import { describe, expect, it } from 'vitest';
import {
  aggregateAIRunStats,
  estimateLLMCostUsd,
  toAIRunSummary,
  zeroAIRunStats,
} from '../telemetry.js';

describe('AI telemetry aggregation', () => {
  it('aggregates call counts, latency, tokens, and cost across calls', () => {
    const stats = aggregateAIRunStats([
      {
        model: 'gpt-4o',
        latencyMs: 120,
        success: true,
        promptTokens: 100,
        completionTokens: 40,
        estimatedCostUsd: 0.0011,
      },
      {
        model: 'gpt-4o',
        latencyMs: 80,
        success: false,
      },
      {
        model: 'gpt-4o',
        latencyMs: 200,
        success: true,
        promptTokens: 60,
        completionTokens: 20,
        estimatedCostUsd: 0.0006,
      },
    ]);

    expect(stats).toEqual({
      model: 'gpt-4o',
      totalCalls: 3,
      successfulCalls: 2,
      failedCalls: 1,
      totalLatencyMs: 400,
      avgLatencyMs: 133.33,
      totalPromptTokens: 160,
      totalCompletionTokens: 60,
      estimatedCostUsd: 0.0017,
    });
  });

  it('returns zeroed stats when no calls are provided', () => {
    expect(aggregateAIRunStats([], 'gpt-4o-mini')).toEqual(zeroAIRunStats('gpt-4o-mini'));
  });

  it('converts aggregated stats into an AIRunSummary with backend', () => {
    const summary = toAIRunSummary(zeroAIRunStats('gpt-4o'), 'cloud');
    expect(summary).toEqual({
      model: 'gpt-4o',
      backend: 'cloud',
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
    });
  });

  it('forces model to off when backend is off', () => {
    const summary = toAIRunSummary(zeroAIRunStats('gpt-4o'), 'off');
    expect(summary.model).toBe('off');
    expect(summary.backend).toBe('off');
  });

  it('estimates OpenAI token cost for known models', () => {
    expect(estimateLLMCostUsd('gpt-5.6-sol', 1000, 500, 'openai')).toBeCloseTo(0.02, 6);
    expect(estimateLLMCostUsd('gpt-5.6-terra', 1000, 500, 'openai')).toBeCloseTo(0.008, 6);
    expect(estimateLLMCostUsd('gpt-5.6-luna', 1000, 500, 'openai')).toBeCloseTo(0.0008, 6);
    expect(estimateLLMCostUsd('gpt-4o', 1000, 500, 'openai')).toBeCloseTo(0.0075, 6);
    expect(estimateLLMCostUsd('gpt-4o-mini', 1000, 500, 'openai')).toBeCloseTo(0.00045, 6);
  });

  it('returns undefined cost for local backends or unknown models', () => {
    expect(estimateLLMCostUsd('gpt-4o', 1000, 500, 'local')).toBeUndefined();
    expect(estimateLLMCostUsd('unknown-model', 1000, 500, 'openai')).toBeUndefined();
  });
});
