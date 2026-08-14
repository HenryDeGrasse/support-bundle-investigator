import type {
  AIFindingResponse,
  InvestigationLLMClient,
  SeedAwareInvestigationLLMClient,
} from './llm-client.js';
import { cassetteSeedKey, type CassetteRecorder, getRecorderMode } from './recorder.js';

export interface SeedIdentity {
  seedId: string;
  seedCategory: string;
}

/**
 * Wraps an investigation LLM client with cassette record/replay behavior.
 *
 * - live: delegates directly to the inner client
 * - record: delegates, then stores the response keyed by current seed
 * - replay: returns cached responses only and never calls the inner client
 */
export class ReplayableLLMClient implements SeedAwareInvestigationLLMClient {
  private currentSeed: SeedIdentity | undefined;

  constructor(
    private readonly inner: InvestigationLLMClient,
    private readonly recorder: CassetteRecorder,
    private readonly seedResolver: (system: string, user: string) => SeedIdentity,
  ) {}

  getModel(): string {
    return getInnerModel(this.inner);
  }

  setSeedContext(seedId: string, seedCategory: string): void {
    this.currentSeed = { seedId, seedCategory };
  }

  clearSeedContext(): void {
    this.currentSeed = undefined;
  }

  async investigateSeed(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AIFindingResponse> {
    const seed = this.currentSeed ?? this.seedResolver(systemPrompt, userPrompt);
    const request = { system: systemPrompt, user: userPrompt };
    const model = getInnerModel(this.inner);

    if (this.recorder.mode === 'replay') {
      const cassette = this.recorder.replay(
        seed.seedId,
        seed.seedCategory,
        request,
        model,
      );
      if (cassette !== undefined) {
        return {
          findings: cassette.response.findings,
          rawResponse: cassette.response.rawResponse,
          telemetry: {
            model: cassette.model,
            latencyMs: 0,
            success: true,
          },
        };
      }

      console.warn(
        `[ReplayableLLMClient] Missing cassette for ${cassetteSeedKey(seed.seedId, seed.seedCategory, request, model)} (${seed.seedId}, ${seed.seedCategory})`,
      );
      return {
        findings: [],
        rawResponse: undefined,
        telemetry: {
          model,
          latencyMs: 0,
          success: false,
        },
      };
    }

    const response = await this.inner.investigateSeed(systemPrompt, userPrompt);

    if (this.recorder.mode === 'record') {
      this.recorder.record(
        seed.seedId,
        seed.seedCategory,
        request,
        { findings: response.findings, rawResponse: response.rawResponse ?? '' },
        model,
      );
    }

    return response;
  }

  async generateText(systemPrompt: string, userPrompt: string): Promise<string> {
    if (this.recorder.mode === 'replay') {
      return '';
    }
    return this.inner.generateText(systemPrompt, userPrompt);
  }
}

function getInnerModel(client: InvestigationLLMClient): string {
  const withModel = client as InvestigationLLMClient & { model?: string };
  if (typeof withModel.model === 'string') {
    return withModel.model;
  }

  const candidate = client as InvestigationLLMClient & { getModel?: () => string };
  if (typeof candidate.getModel === 'function') {
    return candidate.getModel();
  }

  return 'unknown';
}

/**
 * Default seed resolver used as a fallback when no explicit seed context was
 * provided. The AI investigator sets seed context directly, so this path is
 * only a safety net.
 */
export function defaultSeedResolver(systemPrompt: string, userPrompt: string): SeedIdentity {
  const combined = `${systemPrompt}\n${userPrompt}`;
  const mode = getRecorderMode();
  return {
    seedId: `unresolved:${mode}:${combined.length}`,
    seedCategory: 'unknown',
  };
}
