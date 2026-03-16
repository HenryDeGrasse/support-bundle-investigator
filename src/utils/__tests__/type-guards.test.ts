import { describe, expect, it } from 'vitest';
import { isAnalyzerResult, isK8sEvent, isK8sResource } from '../type-guards.js';

/** Helper: return a shallow copy of obj without the given key. */
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

// ---------------------------------------------------------------------------
// isAnalyzerResult
// ---------------------------------------------------------------------------
describe('isAnalyzerResult', () => {
  const valid: Record<string, unknown> = {
    name: 'check-pod-restarts',
    title: 'Pod Restart Check',
    message: 'No excessive restarts found',
    severity: 'pass',
    isPass: true,
    isFail: false,
    isWarn: false,
  };

  it('accepts a fully valid AnalyzerResult', () => {
    expect(isAnalyzerResult(valid)).toBe(true);
  });

  it('accepts a valid AnalyzerResult with optional fields', () => {
    expect(
      isAnalyzerResult({
        ...valid,
        iconKey: 'ok',
        iconUri: 'https://example.com/ok.png',
        uri: 'https://example.com',
      }),
    ).toBe(true);
  });

  it('accepts severity "error"', () => {
    expect(isAnalyzerResult({ ...valid, severity: 'error', isPass: false, isFail: true })).toBe(true);
  });

  it('accepts severity "warn"', () => {
    expect(isAnalyzerResult({ ...valid, severity: 'warn', isPass: false, isWarn: true })).toBe(true);
  });

  it('accepts severity "info"', () => {
    expect(isAnalyzerResult({ ...valid, severity: 'info' })).toBe(true);
  });

  it('rejects null', () => {
    expect(isAnalyzerResult(null)).toBe(false);
  });

  it('rejects a plain string', () => {
    expect(isAnalyzerResult('not an object')).toBe(false);
  });

  it('rejects an empty object', () => {
    expect(isAnalyzerResult({})).toBe(false);
  });

  it('rejects missing name', () => {
    expect(isAnalyzerResult(omit(valid, 'name'))).toBe(false);
  });

  it('rejects missing title', () => {
    expect(isAnalyzerResult(omit(valid, 'title'))).toBe(false);
  });

  it('rejects missing message', () => {
    expect(isAnalyzerResult(omit(valid, 'message'))).toBe(false);
  });

  it('rejects an unknown severity value', () => {
    expect(isAnalyzerResult({ ...valid, severity: 'unknown' })).toBe(false);
  });

  it('rejects non-boolean isPass', () => {
    expect(isAnalyzerResult({ ...valid, isPass: 'yes' })).toBe(false);
  });

  it('rejects non-boolean isFail', () => {
    expect(isAnalyzerResult({ ...valid, isFail: 1 })).toBe(false);
  });

  it('rejects non-boolean isWarn', () => {
    expect(isAnalyzerResult({ ...valid, isWarn: null })).toBe(false);
  });

  it('rejects a non-string iconKey when present', () => {
    expect(isAnalyzerResult({ ...valid, iconKey: 123 })).toBe(false);
  });

  it('rejects a non-string iconUri when present', () => {
    expect(isAnalyzerResult({ ...valid, iconUri: { href: 'https://example.com' } })).toBe(false);
  });

  it('rejects a non-string uri when present', () => {
    expect(isAnalyzerResult({ ...valid, uri: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isK8sResource
// ---------------------------------------------------------------------------
describe('isK8sResource', () => {
  const valid: Record<string, unknown> = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'my-pod', namespace: 'default' },
    spec: { containers: [] },
    status: { phase: 'Running' },
  };

  it('accepts a fully valid K8sResource', () => {
    expect(isK8sResource(valid)).toBe(true);
  });

  it('accepts a resource with optional metadata fields', () => {
    expect(
      isK8sResource({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'web',
          namespace: 'prod',
          creationTimestamp: '2024-01-01T00:00:00Z',
          labels: { app: 'web' },
          annotations: { 'team.example.com/owner': 'support' },
        },
      }),
    ).toBe(true);
  });

  it('accepts a resource without optional spec/status', () => {
    expect(
      isK8sResource({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg' } }),
    ).toBe(true);
  });

  it('accepts a namespaced resource', () => {
    expect(
      isK8sResource({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'web', namespace: 'prod' },
      }),
    ).toBe(true);
  });

  it('rejects null', () => {
    expect(isK8sResource(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isK8sResource(42)).toBe(false);
  });

  it('rejects missing apiVersion', () => {
    expect(isK8sResource(omit(valid, 'apiVersion'))).toBe(false);
  });

  it('rejects missing kind', () => {
    expect(isK8sResource(omit(valid, 'kind'))).toBe(false);
  });

  it('rejects missing metadata', () => {
    expect(isK8sResource(omit(valid, 'metadata'))).toBe(false);
  });

  it('rejects metadata without a name', () => {
    expect(isK8sResource({ ...valid, metadata: { namespace: 'default' } })).toBe(false);
  });

  it('rejects metadata as a non-object', () => {
    expect(isK8sResource({ ...valid, metadata: 'bad' })).toBe(false);
  });

  it('rejects metadata as an array', () => {
    expect(isK8sResource({ ...valid, metadata: [] })).toBe(false);
  });

  it('rejects a non-string metadata namespace when present', () => {
    expect(isK8sResource({ ...valid, metadata: { name: 'my-pod', namespace: 123 } })).toBe(false);
  });

  it('rejects a non-string metadata creationTimestamp when present', () => {
    expect(
      isK8sResource({ ...valid, metadata: { name: 'my-pod', creationTimestamp: 123 } }),
    ).toBe(false);
  });

  it('rejects labels with non-string values', () => {
    expect(
      isK8sResource({ ...valid, metadata: { name: 'my-pod', labels: { app: 123 } } }),
    ).toBe(false);
  });

  it('rejects annotations with non-string values', () => {
    expect(
      isK8sResource({
        ...valid,
        metadata: { name: 'my-pod', annotations: { 'team.example.com/owner': false } },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isK8sEvent
// ---------------------------------------------------------------------------
describe('isK8sEvent', () => {
  const valid: Record<string, unknown> = {
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 'default' },
    firstTimestamp: '2024-01-01T00:00:00Z',
    lastTimestamp: '2024-01-01T01:00:00Z',
    count: 5,
  };

  it('accepts a fully valid K8sEvent', () => {
    expect(isK8sEvent(valid)).toBe(true);
  });

  it('accepts an event without optional timestamp/count fields', () => {
    expect(
      isK8sEvent({
        type: 'Normal',
        reason: 'Scheduled',
        message: 'Assigned',
        involvedObject: { kind: 'Pod', name: 'p' },
      }),
    ).toBe(true);
  });

  it('accepts an involvedObject without optional namespace', () => {
    expect(isK8sEvent({ ...valid, involvedObject: { kind: 'Node', name: 'node-1' } })).toBe(true);
  });

  it('rejects null', () => {
    expect(isK8sEvent(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isK8sEvent('event')).toBe(false);
  });

  it('rejects missing type', () => {
    expect(isK8sEvent(omit(valid, 'type'))).toBe(false);
  });

  it('rejects missing reason', () => {
    expect(isK8sEvent(omit(valid, 'reason'))).toBe(false);
  });

  it('rejects missing message', () => {
    expect(isK8sEvent(omit(valid, 'message'))).toBe(false);
  });

  it('rejects missing involvedObject', () => {
    expect(isK8sEvent(omit(valid, 'involvedObject'))).toBe(false);
  });

  it('rejects involvedObject missing kind', () => {
    expect(isK8sEvent({ ...valid, involvedObject: { name: 'my-pod' } })).toBe(false);
  });

  it('rejects involvedObject missing name', () => {
    expect(isK8sEvent({ ...valid, involvedObject: { kind: 'Pod' } })).toBe(false);
  });

  it('rejects involvedObject as null', () => {
    expect(isK8sEvent({ ...valid, involvedObject: null })).toBe(false);
  });

  it('rejects involvedObject as an array', () => {
    expect(isK8sEvent({ ...valid, involvedObject: [] })).toBe(false);
  });

  it('rejects a non-string involvedObject namespace when present', () => {
    expect(
      isK8sEvent({ ...valid, involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 1 } }),
    ).toBe(false);
  });

  it('rejects a non-string firstTimestamp when present', () => {
    expect(isK8sEvent({ ...valid, firstTimestamp: 1 })).toBe(false);
  });

  it('rejects a non-string lastTimestamp when present', () => {
    expect(isK8sEvent({ ...valid, lastTimestamp: {} })).toBe(false);
  });

  it('rejects a non-number count when present', () => {
    expect(isK8sEvent({ ...valid, count: 'five' })).toBe(false);
  });
});
