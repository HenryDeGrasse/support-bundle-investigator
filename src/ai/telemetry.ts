import type { LLMBackend } from './config.js';

export interface AICallMetrics {
  model: string;
  latencyMs: number;
  success: boolean;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
}

export interface AIRunStats {
  model: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  estimatedCostUsd?: number;
}

export interface AIRunSummary extends AIRunStats {
  backend: 'cloud' | 'local' | 'off';
}

interface ModelPricing {
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
}

const OPENAI_MODEL_PRICING: ReadonlyArray<[prefix: string, pricing: ModelPricing]> = [
  ['gpt-4o-mini', { promptUsdPerMillion: 0.15, completionUsdPerMillion: 0.6 }],
  ['gpt-4o', { promptUsdPerMillion: 5, completionUsdPerMillion: 15 }],
];

function resolvePricing(model: string): ModelPricing | undefined {
  const normalized = model.trim().toLowerCase();
  return OPENAI_MODEL_PRICING.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function estimateLLMCostUsd(
  model: string,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  backend: LLMBackend,
): number | undefined {
  if (backend !== 'openai') {
    return undefined;
  }

  if (promptTokens == null || completionTokens == null) {
    return undefined;
  }

  const pricing = resolvePricing(model);
  if (pricing === undefined) {
    return undefined;
  }

  const promptCost = (promptTokens / 1_000_000) * pricing.promptUsdPerMillion;
  const completionCost = (completionTokens / 1_000_000) * pricing.completionUsdPerMillion;
  return roundUsd(promptCost + completionCost);
}

export function zeroAIRunStats(model = 'unknown'): AIRunStats {
  return {
    model,
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
  };
}

export function aggregateAIRunStats(
  calls: ReadonlyArray<AICallMetrics>,
  fallbackModel = 'unknown',
): AIRunStats {
  if (calls.length === 0) {
    return zeroAIRunStats(fallbackModel);
  }

  const models = [...new Set(calls.map((call) => call.model).filter((model) => model.trim().length > 0))];
  const totalCalls = calls.length;
  const successfulCalls = calls.filter((call) => call.success).length;
  const failedCalls = totalCalls - successfulCalls;
  const totalLatencyMs = calls.reduce((sum, call) => sum + Math.max(0, call.latencyMs), 0);

  const promptTokenCalls = calls.filter((call) => call.promptTokens != null);
  const completionTokenCalls = calls.filter((call) => call.completionTokens != null);
  const costCalls = calls.filter((call) => call.estimatedCostUsd != null);

  return {
    model:
      models.length === 0
        ? fallbackModel
        : models.length === 1
          ? models[0]!
          : 'mixed',
    totalCalls,
    successfulCalls,
    failedCalls,
    totalLatencyMs: roundMs(totalLatencyMs),
    avgLatencyMs: roundMs(totalLatencyMs / totalCalls),
    ...(promptTokenCalls.length > 0
      ? {
          totalPromptTokens: promptTokenCalls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
        }
      : {}),
    ...(completionTokenCalls.length > 0
      ? {
          totalCompletionTokens: completionTokenCalls.reduce(
            (sum, call) => sum + (call.completionTokens ?? 0),
            0,
          ),
        }
      : {}),
    ...(costCalls.length > 0
      ? {
          estimatedCostUsd: roundUsd(
            costCalls.reduce((sum, call) => sum + (call.estimatedCostUsd ?? 0), 0),
          ),
        }
      : {}),
  };
}

export function toAIRunSummary(
  stats: AIRunStats,
  backend: AIRunSummary['backend'],
  fallbackModel?: string,
): AIRunSummary {
  return {
    ...stats,
    model:
      backend === 'off'
        ? 'off'
        : stats.model.trim().length > 0 && stats.model !== 'unknown'
          ? stats.model
          : (fallbackModel ?? 'unknown'),
    backend,
  };
}
