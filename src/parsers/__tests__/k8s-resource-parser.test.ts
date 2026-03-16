import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { parseResourceFile, parseResourceYaml, parseResourceJson } from '../k8s-resource-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../../test/fixtures/scenarios');

const POD_FILE = path.join(
  SCENARIOS,
  'bad-image-tag',
  'cluster-resources',
  'pods',
  'default',
  'app-pod.yaml',
);
const DEPLOYMENT_FILE = path.join(
  SCENARIOS,
  'bad-image-tag',
  'cluster-resources',
  'deployments',
  'default',
  'app-deployment.yaml',
);
const SERVICE_FILE = path.join(
  SCENARIOS,
  'wrong-db-endpoint',
  'cluster-resources',
  'services',
  'default',
  'app-service.yaml',
);

// ---------------------------------------------------------------------------
// Inline YAML helpers
// ---------------------------------------------------------------------------

const SIMPLE_POD_YAML = `\
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: test-ns
  labels:
    app: test
spec:
  containers:
    - name: test-container
      image: test:latest
status:
  phase: Running
`;

const MULTI_DOC_YAML = `\
apiVersion: v1
kind: Pod
metadata:
  name: pod-one
  namespace: default
spec:
  containers:
    - name: c1
      image: img:1
status:
  phase: Running
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deploy-one
  namespace: default
spec:
  replicas: 2
status:
  availableReplicas: 2
`;

const POD_LIST_YAML = `\
apiVersion: v1
kind: PodList
metadata:
  name: pod-list
items:
  - apiVersion: v1
    kind: Pod
    metadata:
      name: listed-pod-1
      namespace: default
    status:
      phase: Running
  - apiVersion: v1
    kind: Pod
    metadata:
      name: listed-pod-2
      namespace: default
    status:
      phase: Pending
`;

const SIMPLE_POD_JSON = JSON.stringify({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'json-pod',
    namespace: 'default',
    labels: { app: 'json-app' },
    creationTimestamp: '2024-01-01T00:00:00Z',
  },
  spec: { containers: [{ name: 'c', image: 'img:1' }] },
  status: { phase: 'Running' },
});

// ---------------------------------------------------------------------------
// parseResourceFile
// ---------------------------------------------------------------------------

describe('parseResourceFile', () => {
  it('parses a single YAML resource file into K8sResource', async () => {
    const resources = await parseResourceFile(POD_FILE);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.kind).toBe('Pod');
    expect(resources[0]?.apiVersion).toBe('v1');
  });

  it('extracts apiVersion, kind, and metadata correctly from file', async () => {
    const resources = await parseResourceFile(POD_FILE);
    const pod = resources[0]!;

    expect(pod.apiVersion).toBe('v1');
    expect(pod.kind).toBe('Pod');
    expect(pod.metadata.name).toBe('app-pod');
    expect(pod.metadata.namespace).toBe('default');
    expect(pod.metadata.labels).toEqual({ app: 'myapp' });
    expect(pod.metadata.creationTimestamp).toBe('2024-01-15T16:00:00Z');
  });

  it('parses pod YAML file and retains status block with phase info', async () => {
    const resources = await parseResourceFile(POD_FILE);
    const pod = resources[0]!;

    // Status is preserved as raw data
    const status = pod.status as Record<string, unknown>;
    expect(status?.['phase']).toBe('Pending');
  });

  it('parses deployment YAML file and retains replicas info', async () => {
    const resources = await parseResourceFile(DEPLOYMENT_FILE);
    expect(resources).toHaveLength(1);

    const deployment = resources[0]!;
    expect(deployment.kind).toBe('Deployment');

    const spec = deployment.spec as Record<string, unknown>;
    expect(spec?.['replicas']).toBe(1);

    const status = deployment.status as Record<string, unknown>;
    expect(status?.['readyReplicas']).toBe(0);
    expect(status?.['availableReplicas']).toBe(0);
  });

  it('parses service YAML file', async () => {
    const resources = await parseResourceFile(SERVICE_FILE);
    expect(resources).toHaveLength(1);

    const service = resources[0]!;
    expect(service.kind).toBe('Service');
    expect(service.apiVersion).toBe('v1');
    expect(service.metadata.name).toBe('app-service');
  });

  it('returns empty array and logs warning for a non-existent file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resources = await parseResourceFile('/no/such/file.yaml');

    expect(resources).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseResourceYaml
// ---------------------------------------------------------------------------

describe('parseResourceYaml', () => {
  it('parses a single YAML document into a K8sResource[]', () => {
    const resources = parseResourceYaml(SIMPLE_POD_YAML);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.kind).toBe('Pod');
    expect(resources[0]?.metadata.name).toBe('test-pod');
    expect(resources[0]?.metadata.namespace).toBe('test-ns');
  });

  it('parses multi-document YAML (--- separated) into K8sResource[]', () => {
    const resources = parseResourceYaml(MULTI_DOC_YAML);

    expect(resources).toHaveLength(2);
    expect(resources[0]?.kind).toBe('Pod');
    expect(resources[0]?.metadata.name).toBe('pod-one');
    expect(resources[1]?.kind).toBe('Deployment');
    expect(resources[1]?.metadata.name).toBe('deploy-one');
  });

  it('handles empty content — returns empty array', () => {
    expect(parseResourceYaml('')).toHaveLength(0);
    expect(parseResourceYaml('   ')).toHaveLength(0);
    expect(parseResourceYaml('\n\n')).toHaveLength(0);
  });

  it('handles malformed YAML gracefully — skips bad documents and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const malformedYaml = `\
apiVersion: v1
kind: Pod
metadata:
  name: good-pod
  namespace: default
---
: invalid: yaml: [unclosed bracket
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: good-config
  namespace: default
`;

    const resources = parseResourceYaml(malformedYaml);

    // At least the valid documents should be returned
    expect(resources.length).toBeGreaterThanOrEqual(1);
    expect(resources.some((r) => r.metadata.name === 'good-pod')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('parses list-type resources (kind: PodList, items: [...]) — unwraps items', () => {
    const resources = parseResourceYaml(POD_LIST_YAML);

    // PodList should be unwrapped into individual Pod resources
    expect(resources).toHaveLength(2);
    expect(resources[0]?.kind).toBe('Pod');
    expect(resources[0]?.metadata.name).toBe('listed-pod-1');
    expect(resources[1]?.kind).toBe('Pod');
    expect(resources[1]?.metadata.name).toBe('listed-pod-2');
  });

  it('skips documents that lack apiVersion or kind', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const yaml = `\
apiVersion: v1
kind: Pod
metadata:
  name: good-pod
  namespace: default
---
metadata:
  name: no-api-version
---
some: random
data: here
`;

    const resources = parseResourceYaml(yaml);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.metadata.name).toBe('good-pod');
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseResourceJson
// ---------------------------------------------------------------------------

describe('parseResourceJson', () => {
  it('parses JSON resource content into K8sResource[]', () => {
    const resources = parseResourceJson(SIMPLE_POD_JSON);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.kind).toBe('Pod');
    expect(resources[0]?.apiVersion).toBe('v1');
    expect(resources[0]?.metadata.name).toBe('json-pod');
    expect(resources[0]?.metadata.namespace).toBe('default');
  });

  it('extracts labels and creationTimestamp from JSON resource', () => {
    const resources = parseResourceJson(SIMPLE_POD_JSON);
    const pod = resources[0]!;

    expect(pod.metadata.labels).toEqual({ app: 'json-app' });
    expect(pod.metadata.creationTimestamp).toBe('2024-01-01T00:00:00Z');
  });

  it('handles malformed JSON gracefully — returns empty array and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resources = parseResourceJson('{ not: valid json }');

    expect(resources).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns empty array and logs warning for non-resource JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resources = parseResourceJson(JSON.stringify({ some: 'data', no: 'resource' }));

    expect(resources).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('parses JSON list-type resource — unwraps items', () => {
    const listJson = JSON.stringify({
      apiVersion: 'v1',
      kind: 'PodList',
      metadata: { name: 'pod-list' },
      items: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'json-pod-1', namespace: 'default' },
          status: { phase: 'Running' },
        },
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'json-pod-2', namespace: 'default' },
          status: { phase: 'Failed' },
        },
      ],
    });

    const resources = parseResourceJson(listJson);

    expect(resources).toHaveLength(2);
    expect(resources[0]?.metadata.name).toBe('json-pod-1');
    expect(resources[1]?.metadata.name).toBe('json-pod-2');
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});
