import type { AnalyzerResult } from '../types/analyzer.js';
import type { K8sEvent, K8sResource } from '../types/kubernetes.js';

const ANALYZER_SEVERITIES = new Set<AnalyzerResult['severity']>(['error', 'warn', 'pass', 'info']);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return typeof value === 'undefined' || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return typeof value === 'undefined' || typeof value === 'number';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObjectRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/**
 * Narrows an unknown value to AnalyzerResult.
 */
export function isAnalyzerResult(x: unknown): x is AnalyzerResult {
  if (!isObjectRecord(x)) return false;

  return (
    typeof x['name'] === 'string' &&
    typeof x['title'] === 'string' &&
    typeof x['message'] === 'string' &&
    typeof x['severity'] === 'string' &&
    ANALYZER_SEVERITIES.has(x['severity'] as AnalyzerResult['severity']) &&
    typeof x['isPass'] === 'boolean' &&
    typeof x['isFail'] === 'boolean' &&
    typeof x['isWarn'] === 'boolean' &&
    isOptionalString(x['iconKey']) &&
    isOptionalString(x['iconUri']) &&
    isOptionalString(x['uri'])
  );
}

/**
 * Narrows an unknown value to K8sResource.
 */
export function isK8sResource(x: unknown): x is K8sResource {
  if (!isObjectRecord(x)) return false;
  if (typeof x['apiVersion'] !== 'string') return false;
  if (typeof x['kind'] !== 'string') return false;
  if (!isObjectRecord(x['metadata'])) return false;

  const metadata = x['metadata'];
  return (
    typeof metadata['name'] === 'string' &&
    isOptionalString(metadata['namespace']) &&
    isOptionalString(metadata['creationTimestamp']) &&
    (typeof metadata['labels'] === 'undefined' || isStringRecord(metadata['labels'])) &&
    (typeof metadata['annotations'] === 'undefined' || isStringRecord(metadata['annotations']))
  );
}

/**
 * Narrows an unknown value to K8sEvent.
 */
export function isK8sEvent(x: unknown): x is K8sEvent {
  if (!isObjectRecord(x)) return false;
  if (typeof x['type'] !== 'string') return false;
  if (typeof x['reason'] !== 'string') return false;
  if (typeof x['message'] !== 'string') return false;
  if (!isObjectRecord(x['involvedObject'])) return false;

  const involvedObject = x['involvedObject'];
  return (
    typeof involvedObject['kind'] === 'string' &&
    typeof involvedObject['name'] === 'string' &&
    isOptionalString(involvedObject['namespace']) &&
    isOptionalString(x['firstTimestamp']) &&
    isOptionalString(x['lastTimestamp']) &&
    isOptionalNumber(x['count'])
  );
}
