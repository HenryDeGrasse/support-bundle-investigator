import type { K8sResource, K8sEvent, AnalyzerResult } from '../types/index.js';
import { extractPodStatus, getContainerErrors } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Pod summary helpers
// ---------------------------------------------------------------------------

function summarizePod(resource: K8sResource): string {
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? 'default';
  const lines: string[] = [`Pod: ${name} (namespace: ${ns})`];

  // Container list with images
  const spec = isRecord(resource.spec) ? (resource.spec as Record<string, unknown>) : {};
  const containers = getArray(spec['containers']);
  const initContainers = getArray(spec['initContainers']);
  const allContainers = [...containers, ...initContainers];

  if (allContainers.length > 0) {
    const containerDescriptions = allContainers
      .filter(isRecord)
      .map((c) => {
        const cName = getString(c['name'], '?');
        const image = getString(c['image'], 'no-image');
        return `  - ${cName}: ${image}`;
      });
    lines.push('Containers:');
    lines.push(...containerDescriptions);
  }

  // Owner references
  const ownerRefs = getArray((resource.metadata as unknown as Record<string, unknown>)['ownerReferences']);
  if (ownerRefs.length > 0) {
    const ownerDescriptions = ownerRefs
      .filter(isRecord)
      .map((ref) => `${getString(ref['kind'])}/${getString(ref['name'])}`);
    lines.push(`OwnedBy: ${ownerDescriptions.join(', ')}`);
  }

  // Referenced Secrets
  const secretNames = extractSecretNames(spec, containers, initContainers);
  if (secretNames.length > 0) {
    lines.push(`ReferencedSecrets: ${secretNames.join(', ')}`);
  }

  // Referenced ConfigMaps
  const configMapNames = extractConfigMapNames(spec, containers, initContainers);
  if (configMapNames.length > 0) {
    lines.push(`ReferencedConfigMaps: ${configMapNames.join(', ')}`);
  }

  // Referenced PVCs
  const pvcNames = extractPvcNames(spec);
  if (pvcNames.length > 0) {
    lines.push(`ReferencedPVCs: ${pvcNames.join(', ')}`);
  }

  // Pod status
  const podStatus = extractPodStatus(resource);
  if (podStatus) {
    lines.push(`Phase: ${podStatus.phase}`);
    lines.push(`TotalRestarts: ${podStatus.restartCount}`);

    const containerErrors = getContainerErrors(resource);
    if (containerErrors.length > 0) {
      lines.push('ContainerErrors:');
      for (const err of containerErrors) {
        lines.push(`  - ${err.container}: ${err.reason}${err.message ? ` — ${err.message}` : ''}`);
      }
    }

    const notReadyCondition = podStatus.conditions.find(
      (c) => c.type === 'Ready' && c.status === 'False',
    );
    if (notReadyCondition) {
      lines.push(
        `NotReady: ${notReadyCondition.reason ?? 'unknown'}${notReadyCondition.message ? ` — ${notReadyCondition.message}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

function extractSecretNames(
  spec: Record<string, unknown>,
  containers: unknown[],
  initContainers: unknown[],
): string[] {
  const names = new Set<string>();

  // volumes
  for (const vol of getArray(spec['volumes'])) {
    if (!isRecord(vol)) continue;
    if (isRecord(vol['secret'])) {
      const n = getString(vol['secret']['secretName']);
      if (n) names.add(n);
    }
  }

  // envFrom + env.valueFrom.secretKeyRef
  for (const c of [...containers, ...initContainers]) {
    if (!isRecord(c)) continue;
    for (const ef of getArray(c['envFrom'])) {
      if (isRecord(ef) && isRecord(ef['secretRef'])) {
        const n = getString(ef['secretRef']['name']);
        if (n) names.add(n);
      }
    }
    for (const ev of getArray(c['env'])) {
      if (!isRecord(ev) || !isRecord(ev['valueFrom'])) continue;
      const vf = ev['valueFrom'] as Record<string, unknown>;
      if (isRecord(vf['secretKeyRef'])) {
        const n = getString(vf['secretKeyRef']['name']);
        if (n) names.add(n);
      }
    }
  }

  return [...names];
}

function extractConfigMapNames(
  spec: Record<string, unknown>,
  containers: unknown[],
  initContainers: unknown[],
): string[] {
  const names = new Set<string>();

  // volumes
  for (const vol of getArray(spec['volumes'])) {
    if (!isRecord(vol)) continue;
    if (isRecord(vol['configMap'])) {
      const n = getString(vol['configMap']['name']);
      if (n) names.add(n);
    }
  }

  // envFrom + env.valueFrom.configMapKeyRef
  for (const c of [...containers, ...initContainers]) {
    if (!isRecord(c)) continue;
    for (const ef of getArray(c['envFrom'])) {
      if (isRecord(ef) && isRecord(ef['configMapRef'])) {
        const n = getString(ef['configMapRef']['name']);
        if (n) names.add(n);
      }
    }
    for (const ev of getArray(c['env'])) {
      if (!isRecord(ev) || !isRecord(ev['valueFrom'])) continue;
      const vf = ev['valueFrom'] as Record<string, unknown>;
      if (isRecord(vf['configMapKeyRef'])) {
        const n = getString(vf['configMapKeyRef']['name']);
        if (n) names.add(n);
      }
    }
  }

  return [...names];
}

function extractPvcNames(spec: Record<string, unknown>): string[] {
  const names = new Set<string>();

  for (const vol of getArray(spec['volumes'])) {
    if (!isRecord(vol) || !isRecord(vol['persistentVolumeClaim'])) continue;
    const n = getString(vol['persistentVolumeClaim']['claimName']);
    if (n) names.add(n);
  }

  return [...names];
}

// ---------------------------------------------------------------------------
// Deployment / StatefulSet / ReplicaSet / DaemonSet summary
// ---------------------------------------------------------------------------

function summarizeWorkload(resource: K8sResource): string {
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? 'default';
  const lines: string[] = [`${resource.kind}: ${name} (namespace: ${ns})`];

  if (isRecord(resource.spec)) {
    const spec = resource.spec as Record<string, unknown>;
    const replicas = getNumber(spec['replicas'], -1);
    if (replicas >= 0) lines.push(`Replicas: ${replicas}`);

    const template = isRecord(spec['template']) ? (spec['template'] as Record<string, unknown>) : {};
    const podSpec = isRecord(template['spec']) ? (template['spec'] as Record<string, unknown>) : {};
    const containers = getArray(podSpec['containers']);
    const initContainers = getArray(podSpec['initContainers']);
    const allContainers = [...containers, ...initContainers];

    if (allContainers.length > 0) {
      const containerDescriptions = allContainers
        .filter(isRecord)
        .map((c) => `${getString(c['name'], '?')}: ${getString(c['image'], 'no-image')}`);
      lines.push('Containers:');
      lines.push(...containerDescriptions.map((description) => `  - ${description}`));

      const images = allContainers
        .filter(isRecord)
        .map((c) => getString(c['image'], 'no-image'));
      lines.push(`Images: ${images.join(', ')}`);
    }

    const secretNames = extractSecretNames(podSpec, containers, initContainers);
    if (secretNames.length > 0) {
      lines.push(`ReferencedSecrets: ${secretNames.join(', ')}`);
    }

    const configMapNames = extractConfigMapNames(podSpec, containers, initContainers);
    if (configMapNames.length > 0) {
      lines.push(`ReferencedConfigMaps: ${configMapNames.join(', ')}`);
    }

    const pvcNames = extractPvcNames(podSpec);
    if (pvcNames.length > 0) {
      lines.push(`ReferencedPVCs: ${pvcNames.join(', ')}`);
    }
  }

  if (isRecord(resource.status)) {
    const status = resource.status as Record<string, unknown>;
    const ready = getNumber(status['readyReplicas'], -1);
    const available = getNumber(status['availableReplicas'], -1);
    if (ready >= 0) lines.push(`ReadyReplicas: ${ready}`);
    if (available >= 0) lines.push(`AvailableReplicas: ${available}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ConfigMap summary
// ---------------------------------------------------------------------------

function summarizeConfigMap(resource: K8sResource): string {
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? 'default';
  const lines: string[] = [`ConfigMap: ${name} (namespace: ${ns})`];

  if (isRecord(resource as unknown as Record<string, unknown>)) {
    const raw = resource as unknown as Record<string, unknown>;
    if (isRecord(raw['data'])) {
      const keys = Object.keys(raw['data'] as Record<string, unknown>);
      lines.push(`Keys: ${keys.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Secret summary (no values — just existence + key names)
// ---------------------------------------------------------------------------

function summarizeSecret(resource: K8sResource): string {
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? 'default';
  const lines: string[] = [`Secret: ${name} (namespace: ${ns})`];

  const raw = resource as unknown as Record<string, unknown>;
  const secretType = getString(raw['type'], 'Opaque');
  lines.push(`Type: ${secretType}`);

  if (isRecord(raw['data'])) {
    const keys = Object.keys(raw['data'] as Record<string, unknown>);
    lines.push(`Keys: ${keys.join(', ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generic fallback summary
// ---------------------------------------------------------------------------

function summarizeGenericResource(resource: K8sResource): string {
  const name = resource.metadata.name;
  const ns = resource.metadata.namespace ?? 'default';
  return `${resource.kind}: ${name} (namespace: ${ns})`;
}

// ---------------------------------------------------------------------------
// Public: summarizeResource
// ---------------------------------------------------------------------------

/**
 * Produces a human-readable, single-string summary of a K8s resource.
 *
 * The summary includes all identifiers that are useful for cross-source
 * correlation: name, namespace, container images, referenced Secrets/ConfigMaps,
 * owner references, and status details.
 *
 * No secret values are included — only key names and existence.
 */
export function summarizeResource(resource: K8sResource): string {
  switch (resource.kind) {
    case 'Pod':
      return summarizePod(resource);
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'DaemonSet':
      return summarizeWorkload(resource);
    case 'ConfigMap':
      return summarizeConfigMap(resource);
    case 'Secret':
      return summarizeSecret(resource);
    default:
      return summarizeGenericResource(resource);
  }
}

// ---------------------------------------------------------------------------
// Public: summarizeEvent
// ---------------------------------------------------------------------------

/**
 * Produces a human-readable summary of a K8s event.
 *
 * Includes type, reason, involved object, message, and timing metadata.
 */
export function summarizeEvent(event: K8sEvent): string {
  const obj = event.involvedObject;
  const parts: string[] = [
    `[${event.type}] ${event.reason} on ${obj.kind}/${obj.name}`,
  ];

  if (obj.namespace) {
    parts[0] += ` (namespace: ${obj.namespace})`;
  }

  parts.push(`Message: ${event.message}`);

  if (event.count !== undefined && event.count > 1) {
    parts.push(`Count: ${event.count}`);
  }

  if (event.firstTimestamp) {
    parts.push(`First: ${event.firstTimestamp}`);
  }

  if (event.lastTimestamp && event.lastTimestamp !== event.firstTimestamp) {
    parts.push(`Last: ${event.lastTimestamp}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public: summarizeAnalyzer
// ---------------------------------------------------------------------------

/**
 * Produces a human-readable summary of an analyzer result.
 *
 * Includes the severity, title, name, and full message.
 */
export function summarizeAnalyzer(result: AnalyzerResult): string {
  const status = result.isPass ? 'PASS' : result.isFail ? 'FAIL' : result.isWarn ? 'WARN' : result.severity.toUpperCase();
  const lines: string[] = [
    `[${status}] ${result.title}`,
    `Analyzer: ${result.name}`,
    `Message: ${result.message}`,
  ];

  if (result.uri) {
    lines.push(`Reference: ${result.uri}`);
  }

  return lines.join('\n');
}
