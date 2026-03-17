import { describe, it, expect } from 'vitest';
import { loadAIConfig, isAIEnabled } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Saves and restores specific env vars around a test. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, orig] of Object.entries(originals)) {
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadAIConfig()', () => {
  it('returns defaults when no env vars are set', () => {
    withEnv(
      { OPENAI_API_KEY: undefined, SBI_AI_MODEL: undefined, SBI_EMBEDDING_MODEL: undefined },
      () => {
        const config = loadAIConfig();
        expect(config.model).toBe('gpt-4o');
        expect(config.embeddingModel).toBe('text-embedding-3-small');
        expect(config.apiKey).toBe('');
        expect(config.provider).toBe('none');
        expect(config.enabled).toBe(false);
      },
    );
  });

  it('reads OPENAI_API_KEY from env', () => {
    withEnv({ OPENAI_API_KEY: 'sk-test-key' }, () => {
      const config = loadAIConfig();
      expect(config.apiKey).toBe('sk-test-key');
    });
  });

  it('reads SBI_AI_MODEL from env', () => {
    withEnv({ OPENAI_API_KEY: 'sk-key', SBI_AI_MODEL: 'gpt-4-turbo' }, () => {
      const config = loadAIConfig();
      expect(config.model).toBe('gpt-4-turbo');
    });
  });

  it('reads SBI_EMBEDDING_MODEL from env', () => {
    withEnv(
      { OPENAI_API_KEY: 'sk-key', SBI_EMBEDDING_MODEL: 'text-embedding-ada-002' },
      () => {
        const config = loadAIConfig();
        expect(config.embeddingModel).toBe('text-embedding-ada-002');
      },
    );
  });

  it('enables AI when API key is present and noAi is not set', () => {
    withEnv({ OPENAI_API_KEY: 'sk-valid-key' }, () => {
      const config = loadAIConfig();
      expect(config.enabled).toBe(true);
      expect(config.provider).toBe('openai');
    });
  });

  it('disables AI when API key is present but noAi is true', () => {
    withEnv({ OPENAI_API_KEY: 'sk-valid-key' }, () => {
      const config = loadAIConfig({ noAi: true });
      expect(config.enabled).toBe(false);
      expect(config.provider).toBe('none');
    });
  });

  it('disables AI when aiProvider override is none', () => {
    withEnv({ OPENAI_API_KEY: 'sk-valid-key' }, () => {
      const config = loadAIConfig({ aiProvider: 'none' });
      expect(config.enabled).toBe(false);
      expect(config.provider).toBe('none');
    });
  });

  it('accepts aiProvider override in a case-insensitive way', () => {
    withEnv({ OPENAI_API_KEY: 'sk-valid-key' }, () => {
      const config = loadAIConfig({ aiProvider: ' OpenAI ' });
      expect(config.enabled).toBe(true);
      expect(config.provider).toBe('openai');
    });
  });

  it('disables AI when API key is missing and noAi is false', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      const config = loadAIConfig({ noAi: false });
      expect(config.enabled).toBe(false);
    });
  });

  it('disables AI when API key is an empty string', () => {
    withEnv({ OPENAI_API_KEY: '' }, () => {
      const config = loadAIConfig();
      expect(config.enabled).toBe(false);
    });
  });

  it('disables AI when API key is whitespace only', () => {
    withEnv({ OPENAI_API_KEY: '   ' }, () => {
      const config = loadAIConfig();
      expect(config.enabled).toBe(false);
    });
  });

  it('disables AI when both key is missing and noAi is true', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      const config = loadAIConfig({ noAi: true });
      expect(config.enabled).toBe(false);
      expect(config.provider).toBe('none');
    });
  });
});

describe('isAIEnabled()', () => {
  it('returns false when config.enabled is false', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      const config = loadAIConfig();
      expect(isAIEnabled(config)).toBe(false);
    });
  });

  it('returns false when noAi overrides a present key', () => {
    withEnv({ OPENAI_API_KEY: 'sk-key' }, () => {
      const config = loadAIConfig({ noAi: true });
      expect(isAIEnabled(config)).toBe(false);
    });
  });

  it('returns true when key is present and noAi is not set', () => {
    withEnv({ OPENAI_API_KEY: 'sk-real-key' }, () => {
      const config = loadAIConfig();
      expect(isAIEnabled(config)).toBe(true);
    });
  });
});
