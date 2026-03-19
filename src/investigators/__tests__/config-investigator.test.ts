import { describe, it, expect } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile, K8sResource } from '../../types/index.js';
import type { LogFile } from '../../parsers/index.js';
import { investigateConfig } from '../config-investigator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal BundleProfile — investigator does not inspect profile fields. */
function makeProfile(): BundleProfile {
  return {
    manifest: {
      bundlePath: '',
      extractedPath: '',
      files: [],
      totalSize: 0,
      extractedAt: new Date(),
    },
    analyzerCount: 0,
    logFileCount: 0,
    resourceCount: 0,
    eventCount: 0,
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
  };
}

function makeContext(partial: Partial<InvestigatorContext> = {}): InvestigatorContext {
  return {
    analyzerResults: [],
    resources: [],
    events: [],
    logs: [] as LogFile[],
    profile: makeProfile(),
    ...partial,
  };
}

const noSeeds: InvestigationSeed[] = [];

// ---------------------------------------------------------------------------
// Resource fixtures
// ---------------------------------------------------------------------------

/** A Service in namespace 'default'. */
function makeService(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace },
    spec: { selector: { app: name } },
    status: {},
  };
}

/** A Secret in namespace 'default'. */
function makeSecret(name: string, namespace = 'default'): K8sResource {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
  };
}

/**
 * A Pod with a single container that has `DB_HOST` and `API_ENDPOINT` env
 * vars pointing to services that may or may not exist.
 */
const podWithEnvServiceRefs: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        env: [
          { name: 'DB_HOST', value: 'my-postgres' },
          { name: 'CACHE_ADDR', value: 'redis-cache:6379' },
          { name: 'APP_NAME', value: 'my-application' }, // not a service-host key
          { name: 'LOG_LEVEL', value: 'debug' },         // not a service-host key
        ],
      },
    ],
  },
  status: {},
};

/**
 * A Pod with a URL-form service reference in an env var.
 */
const podWithUrlEnvRef: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'web-pod', namespace: 'staging' },
  spec: {
    containers: [
      {
        name: 'web',
        image: 'webapp:v2.0.0',
        env: [
          { name: 'API_ENDPOINT', value: 'http://api-service:8080/v1' },
        ],
      },
    ],
  },
  status: {},
};

/**
 * A Pod with a fully-qualified in-cluster service hostname.
 */
const podWithFqdnServiceRef: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'fqdn-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        env: [
          { name: 'API_ENDPOINT', value: 'http://api-service.staging.svc.cluster.local:8080/v1' },
        ],
      },
    ],
  },
  status: {},
};

/**
 * A Pod that references a secret via a volume mount.
 */
const podWithVolumeSec: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    volumes: [
      { name: 'credentials', secret: { secretName: 'app-credentials' } },
    ],
    containers: [
      { name: 'app', image: 'myapp:v1.0.0' },
    ],
  },
  status: {},
};

/**
 * A Pod that references a secret via envFrom.secretRef.
 */
const podWithEnvFromSec: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'api-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'api',
        image: 'myapi:v1.0.0',
        envFrom: [
          { secretRef: { name: 'api-secrets' } },
        ],
      },
    ],
  },
  status: {},
};

/**
 * A Pod that references a secret via env[].valueFrom.secretKeyRef.
 */
const podWithSecretKeyRef: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'worker-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'worker',
        image: 'myworker:v1.0.0',
        env: [
          {
            name: 'DB_PASSWORD',
            valueFrom: { secretKeyRef: { name: 'db-credentials', key: 'password' } },
          },
        ],
      },
    ],
  },
  status: {},
};

/**
 * A Pod with a spec image that differs from its running (status) image.
 */
const podWithImageMismatch: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'deploy-pod', namespace: 'default' },
  spec: {
    containers: [
      { name: 'app', image: 'myapp:v2.0.0' },
    ],
  },
  status: {
    phase: 'Running',
    containerStatuses: [
      { name: 'app', image: 'myapp:v1.5.0', ready: true, restartCount: 0, state: {} },
    ],
  },
};

/**
 * A Pod whose spec and status images match — no finding expected.
 */
const podWithMatchingImages: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'stable-pod', namespace: 'default' },
  spec: {
    containers: [
      { name: 'app', image: 'myapp:v1.0.0' },
    ],
  },
  status: {
    phase: 'Running',
    containerStatuses: [
      { name: 'app', image: 'myapp:v1.0.0', ready: true, restartCount: 0, state: {} },
    ],
  },
};

/**
 * A Pod whose status image has a digest appended — should still match
 * after normalisation.
 */
const podWithDigestSuffix: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'digest-pod', namespace: 'default' },
  spec: {
    containers: [
      { name: 'app', image: 'myapp:v1.0.0' },
    ],
  },
  status: {
    phase: 'Running',
    containerStatuses: [
      {
        name: 'app',
        image: 'myapp:v1.0.0@sha256:abc1234567890',
        ready: true,
        restartCount: 0,
        state: {},
      },
    ],
  },
};

/**
 * A Deployment whose desired image no longer matches the running pod image.
 */
const deploymentWithUpdatedImage: K8sResource = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web-deployment', namespace: 'default' },
  spec: {
    selector: { matchLabels: { app: 'web', tier: 'frontend' } },
    template: {
      spec: {
        containers: [
          { name: 'app', image: 'webapp:v2.0.0' },
        ],
      },
    },
  },
  status: {},
};

const podManagedByDeployment: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'web-pod-abc123',
    namespace: 'default',
    labels: { app: 'web', tier: 'frontend', podTemplateHash: 'abc123' },
  },
  spec: {
    containers: [
      { name: 'app', image: 'webapp:v2.0.0' },
    ],
  },
  status: {
    phase: 'Running',
    containerStatuses: [
      { name: 'app', image: 'webapp:v1.9.0', ready: true, restartCount: 0, state: {} },
    ],
  },
};

// ---------------------------------------------------------------------------
// Scenario 1 — Env var references to non-existent services
// ---------------------------------------------------------------------------

describe('investigateConfig — env var service refs (service missing)', () => {
  // Bundle has a Service resource (so the namespace is checked) but it's the
  // wrong service — 'other-service', not 'my-postgres' or 'redis-cache'
  const context = makeContext({
    resources: [
      podWithEnvServiceRefs,
      makeService('other-service', 'default'),
    ],
  });
  const result = investigateConfig(context, noSeeds);

  it('produces one finding for the pod with missing service env refs', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity high', () => {
    expect(result.findings[0]!.severity).toBe('high');
  });

  it('finding title references the pod name', () => {
    expect(result.findings[0]!.title.toLowerCase()).toContain('app-pod');
  });

  it('finding confidence is in [0, 1]', () => {
    const c = result.findings[0]!.confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('confidence is CONF_MISSING_SERVICE_ENV_REF (0.80)', () => {
    expect(result.findings[0]!.confidence).toBe(0.80);
  });

  it('evidence includes the pod resource path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/app-pod'))).toBe(true);
  });

  it('evidence includes the missing service path(s)', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    const notes = result.findings[0]!.evidence.map((e) => e.note.toLowerCase());
    // my-postgres and/or redis-cache should appear
    const hasServiceEvidence =
      paths.some((p) => p.includes('services/default/')) ||
      notes.some((n) => n.includes('my-postgres') || n.includes('redis-cache'));
    expect(hasServiceEvidence).toBe(true);
  });

  it('first evidence note references the env var key=value', () => {
    const note = result.findings[0]!.evidence[0]!.note;
    expect(note).toContain('DB_HOST');
  });

  it('affectedComponents includes the pod and missing service(s)', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('app-pod'))).toBe(true);
    expect(comps.some((c) => c.includes('Service/'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    expect(result.findings[0]!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('recommendedAction is non-empty', () => {
    expect(result.findings[0]!.recommendedAction).toBeTruthy();
  });

  it('produces graph edges linking evidence to the finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1b — Env var ref: service exists — no finding
// ---------------------------------------------------------------------------

describe('investigateConfig — env var service refs (service exists)', () => {
  it('produces no finding when the referenced service exists', () => {
    const context = makeContext({
      resources: [
        podWithEnvServiceRefs,
        makeService('my-postgres', 'default'),
        makeService('redis-cache', 'default'),
      ],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1c — Env var ref: no services in bundle — skip check
// ---------------------------------------------------------------------------

describe('investigateConfig — env var service refs (no services in bundle)', () => {
  it('produces no finding when no Service resources are in the bundle', () => {
    // Without any Services, we can't determine whether one is missing
    const context = makeContext({
      resources: [podWithEnvServiceRefs],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1d — Env var ref: key doesn't match service-host pattern
// ---------------------------------------------------------------------------

describe('investigateConfig — env var service refs (non-matching key pattern)', () => {
  it('ignores env vars whose keys do not match the service-host pattern', () => {
    const podWithIrrelevantEnv: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'misc-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'myapp:v1.0.0',
            env: [
              { name: 'APP_NAME', value: 'my-app' },
              { name: 'LOG_LEVEL', value: 'info' },
              { name: 'REPLICAS', value: '3' },
            ],
          },
        ],
      },
      status: {},
    };
    const context = makeContext({
      resources: [podWithIrrelevantEnv, makeService('some-service', 'default')],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1e — Env var ref: URL form service reference
// ---------------------------------------------------------------------------

describe('investigateConfig — env var service refs (URL form)', () => {
  it('extracts service name from URL-style env var value', () => {
    const serviceInStagingNs = makeService('other-svc', 'staging');
    const context = makeContext({
      resources: [podWithUrlEnvRef, serviceInStagingNs],
    });
    const result = investigateConfig(context, noSeeds);
    // api-service is referenced but doesn't exist
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence[0]!.note).toContain('API_ENDPOINT');
  });

  it('resolves fully-qualified in-cluster service hosts across namespaces', () => {
    const context = makeContext({
      resources: [podWithFqdnServiceRef, makeService('other-svc', 'staging')],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence.some((e) => e.path.includes('services/staging/api-service'))).toBe(true);
  });

  it('does not flag external FQDNs (values with dots)', () => {
    const podWithExternalFqdn: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'ext-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'myapp:v1.0.0',
            env: [
              { name: 'EXTERNAL_HOST', value: 'api.external.com' },
            ],
          },
        ],
      },
      status: {},
    };
    const context = makeContext({
      resources: [podWithExternalFqdn, makeService('some-service', 'default')],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Missing secret via volume mount
// ---------------------------------------------------------------------------

describe('investigateConfig — missing secret (volume mount)', () => {
  // Bundle has a Secret in the namespace (so check runs) but not the one
  // referenced by the pod
  const context = makeContext({
    resources: [
      podWithVolumeSec,
      makeSecret('some-other-secret', 'default'),
    ],
  });
  const result = investigateConfig(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity critical', () => {
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('finding title references the pod name and secret name', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('app-pod');
    expect(title).toContain('missing secret');
  });

  it('confidence is CONF_MISSING_SECRET (0.90)', () => {
    expect(result.findings[0]!.confidence).toBe(0.90);
  });

  it('evidence includes the pod resource path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/app-pod'))).toBe(true);
  });

  it('evidence includes the missing secret path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('secrets/default/app-credentials'))).toBe(true);
  });

  it('pod evidence note mentions volume and secret name', () => {
    const podNote = result.findings[0]!.evidence[0]!.note.toLowerCase();
    expect(podNote).toContain('app-credentials');
    expect(podNote).toContain('volume');
  });

  it('missing-secret evidence note confirms the secret is not found', () => {
    const secNote = result.findings[0]!.evidence
      .find((e) => e.path.includes('secrets'))
      ?.note.toLowerCase();
    expect(secNote).toContain('not found');
  });

  it('affectedComponents includes pod and secret', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('app-pod'))).toBe(true);
    expect(comps.some((c) => c.includes('Secret/'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    expect(result.findings[0]!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('recommendedAction mentions kubectl create secret', () => {
    expect(result.findings[0]!.recommendedAction.toLowerCase()).toContain('kubectl');
  });

  it('produces support edges from evidence to finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2b — Missing secret via envFrom.secretRef
// ---------------------------------------------------------------------------

describe('investigateConfig — missing secret (envFrom.secretRef)', () => {
  const context = makeContext({
    resources: [
      podWithEnvFromSec,
      makeSecret('other-secret', 'default'),
    ],
  });
  const result = investigateConfig(context, noSeeds);

  it('produces one finding for envFrom secretRef', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding title references the pod name', () => {
    expect(result.findings[0]!.title.toLowerCase()).toContain('api-pod');
  });

  it('pod evidence note mentions envFrom.secretRef', () => {
    const note = result.findings[0]!.evidence[0]!.note.toLowerCase();
    expect(note).toContain('envfrom');
  });

  it('evidence includes path for missing secret api-secrets', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('api-secrets'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2c — Missing secret via env.valueFrom.secretKeyRef
// ---------------------------------------------------------------------------

describe('investigateConfig — missing secret (secretKeyRef)', () => {
  const context = makeContext({
    resources: [
      podWithSecretKeyRef,
      makeSecret('other-secret', 'default'),
    ],
  });
  const result = investigateConfig(context, noSeeds);

  it('produces one finding for secretKeyRef', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding title references the worker-pod', () => {
    expect(result.findings[0]!.title.toLowerCase()).toContain('worker-pod');
  });

  it('pod evidence note mentions secretKeyRef and env var name', () => {
    const note = result.findings[0]!.evidence[0]!.note.toLowerCase();
    expect(note).toContain('secretkeyref');
    expect(note).toContain('db_password');
  });

  it('evidence includes path for missing db-credentials secret', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('db-credentials'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2d — Secret exists — no finding
// ---------------------------------------------------------------------------

describe('investigateConfig — secret exists — no finding', () => {
  it('produces no finding when the referenced secret exists', () => {
    const context = makeContext({
      resources: [
        podWithVolumeSec,
        makeSecret('app-credentials', 'default'),
      ],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2e — No secrets in namespace — skip check
// ---------------------------------------------------------------------------

describe('investigateConfig — missing secret (no secrets in bundle for namespace)', () => {
  it('produces no finding when no Secrets are captured for the pod namespace', () => {
    // Without any Secret resources for 'default', we can't determine if one is missing
    const context = makeContext({
      resources: [podWithVolumeSec],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });

  it('still checks a namespace when secrets from a DIFFERENT namespace are captured', () => {
    // Secrets in 'other-ns' don't help us check 'default'
    const context = makeContext({
      resources: [
        podWithVolumeSec, // namespace: default
        makeSecret('some-secret', 'other-ns'),
      ],
    });
    const result = investigateConfig(context, noSeeds);
    // 'default' namespace has no secrets captured → skip
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Image tag mismatch
// ---------------------------------------------------------------------------

describe('investigateConfig — image tag mismatch', () => {
  const context = makeContext({ resources: [podWithImageMismatch] });
  const result = investigateConfig(context, noSeeds);

  it('produces exactly one finding', () => {
    expect(result.findings).toHaveLength(1);
  });

  it('finding has severity medium', () => {
    expect(result.findings[0]!.severity).toBe('medium');
  });

  it('finding title references container name and pod name', () => {
    const title = result.findings[0]!.title.toLowerCase();
    expect(title).toContain('image tag mismatch');
    expect(title).toContain('deploy-pod');
    expect(title).toContain('app');
  });

  it('confidence is CONF_IMAGE_TAG_MISMATCH (0.85)', () => {
    expect(result.findings[0]!.confidence).toBe(0.85);
  });

  it('evidence includes the pod file path', () => {
    const paths = result.findings[0]!.evidence.map((e) => e.path);
    expect(paths.some((p) => p.includes('pods/default/deploy-pod'))).toBe(true);
  });

  it('evidence note contains both spec and status images', () => {
    const note = result.findings[0]!.evidence[0]!.note;
    expect(note).toContain('myapp:v2.0.0');
    expect(note).toContain('myapp:v1.5.0');
  });

  it('affectedComponents includes pod, container, and both image refs', () => {
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('deploy-pod'))).toBe(true);
    expect(comps.some((c) => c.includes('Container/app'))).toBe(true);
    expect(comps.some((c) => c.includes('myapp:v2.0.0'))).toBe(true);
    expect(comps.some((c) => c.includes('myapp:v1.5.0'))).toBe(true);
  });

  it('contradictionsChecked is non-empty', () => {
    expect(result.findings[0]!.contradictionsChecked.length).toBeGreaterThan(0);
  });

  it('recommendedAction mentions rollout', () => {
    expect(result.findings[0]!.recommendedAction.toLowerCase()).toContain('rollout');
  });

  it('produces a support edge from evidence to finding', () => {
    const findingId = result.findings[0]!.id;
    const supportEdges = result.edges.filter(
      (e) => e.target === findingId && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3b — Deployment image differs from running pod image
// ---------------------------------------------------------------------------

describe('investigateConfig — deployment image tag mismatch', () => {
  it('compares deployment template images against matching pod status images', () => {
    const context = makeContext({
      resources: [deploymentWithUpdatedImage, podManagedByDeployment],
    });
    const result = investigateConfig(context, noSeeds);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.affectedComponents).toContain('Deployment/default/web-deployment');
    expect(result.findings[0]!.evidence.some((e) => e.path.includes('deployments/default/web-deployment'))).toBe(true);
    expect(result.findings[0]!.evidence.some((e) => e.path.includes('pods/default/web-pod-abc123'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3c — Images match — no finding
// ---------------------------------------------------------------------------

describe('investigateConfig — image tag match — no finding', () => {
  it('produces no finding when spec and status images are identical', () => {
    const context = makeContext({ resources: [podWithMatchingImages] });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3c — Digest suffix is normalised away — no finding
// ---------------------------------------------------------------------------

describe('investigateConfig — image digest normalisation', () => {
  it('produces no finding when the only difference is a sha256 digest suffix', () => {
    const context = makeContext({ resources: [podWithDigestSuffix] });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3d — No status containerStatuses — no finding
// ---------------------------------------------------------------------------

describe('investigateConfig — image mismatch (no status)', () => {
  it('produces no finding for a pod without status containerStatuses', () => {
    const podNoStatus: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'pending-pod', namespace: 'default' },
      spec: {
        containers: [{ name: 'app', image: 'myapp:v1.0.0' }],
      },
      status: { phase: 'Pending' }, // no containerStatuses
    };
    const context = makeContext({ resources: [podNoStatus] });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Combined context: all three types of findings
// ---------------------------------------------------------------------------

describe('investigateConfig — combined context (all three finding types)', () => {
  const context = makeContext({
    resources: [
      // Env var service ref (other-svc exists, but my-postgres doesn't)
      podWithEnvServiceRefs,
      makeService('other-service', 'default'),
      // Missing secret (some-other-secret exists but not app-credentials)
      podWithVolumeSec,
      makeSecret('some-other-secret', 'default'),
      // Image mismatch
      podWithImageMismatch,
    ],
  });
  const result = investigateConfig(context, noSeeds);

  it('produces exactly three findings', () => {
    // 1 env-service-ref + 1 missing-secret + 1 image-mismatch
    expect(result.findings).toHaveLength(3);
  });

  it('all findings have confidence in [0, 1]', () => {
    for (const f of result.findings) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('all findings have non-empty evidence arrays', () => {
    for (const f of result.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('all evidence paths are non-empty strings', () => {
    for (const f of result.findings) {
      for (const ev of f.evidence) {
        expect(typeof ev.path).toBe('string');
        expect(ev.path.length).toBeGreaterThan(0);
      }
    }
  });

  it('all findings have non-empty contradictionsChecked arrays', () => {
    for (const f of result.findings) {
      expect(f.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('all findings have non-empty recommendedAction', () => {
    for (const f of result.findings) {
      expect(f.recommendedAction).toBeTruthy();
    }
  });

  it('all edges have non-empty id, source, and target', () => {
    for (const edge of result.edges) {
      expect(edge.id).toBeTruthy();
      expect(edge.source).toBeTruthy();
      expect(edge.target).toBeTruthy();
    }
  });

  it('finding IDs are unique', () => {
    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('edge IDs are unique', () => {
    const ids = result.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findings include one critical, one high, and one medium', () => {
    const severities = result.findings.map((f) => f.severity).sort();
    expect(severities).toContain('critical');
    expect(severities).toContain('high');
    expect(severities).toContain('medium');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Empty context
// ---------------------------------------------------------------------------

describe('investigateConfig — empty context', () => {
  it('returns no findings and no edges for an empty context', () => {
    const context = makeContext();
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Seeds parameter does not affect output
// ---------------------------------------------------------------------------

describe('investigateConfig — seeds parameter', () => {
  it('produces the same findings with and without seeds', () => {
    const seeds: InvestigationSeed[] = [
      {
        id: 'seed:config:0',
        hypothesis: 'Pod app-pod may be missing a secret',
        source: 'pod:default/app-pod',
        category: 'configuration',
        priority: 80,
      },
    ];
    const context = makeContext({
      resources: [podWithVolumeSec, makeSecret('some-other-secret', 'default')],
    });
    const withSeeds = investigateConfig(context, seeds);
    const withoutSeeds = investigateConfig(context, []);
    expect(withSeeds.findings.length).toBe(withoutSeeds.findings.length);
    expect(withSeeds.findings[0]!.id).toBe(withoutSeeds.findings[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Multiple pods with the same missing secret — separate findings
// ---------------------------------------------------------------------------

describe('investigateConfig — multiple pods missing the same secret', () => {
  it('produces a separate finding per pod', () => {
    const pod2: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'second-pod', namespace: 'default' },
      spec: {
        volumes: [
          { name: 'creds', secret: { secretName: 'app-credentials' } },
        ],
        containers: [{ name: 'svc', image: 'svc:v1.0.0' }],
      },
      status: {},
    };
    const context = makeContext({
      resources: [
        podWithVolumeSec,
        pod2,
        makeSecret('other-secret', 'default'),
      ],
    });
    const result = investigateConfig(context, noSeeds);
    expect(result.findings).toHaveLength(2);
    const titles = result.findings.map((f) => f.title);
    expect(titles.some((t) => t.includes('app-pod'))).toBe(true);
    expect(titles.some((t) => t.includes('second-pod'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Namespace isolation for service env refs
// ---------------------------------------------------------------------------

describe('investigateConfig — namespace isolation for service env refs', () => {
  it('does not report a missing service if the service exists in another namespace', () => {
    // 'my-postgres' exists in namespace 'prod', not in 'default'
    const context = makeContext({
      resources: [
        podWithEnvServiceRefs, // namespace: default
        makeService('my-postgres', 'prod'),
        makeService('redis-cache', 'prod'),
        makeService('sentinel-service', 'default'), // exists in default, but not the right one
      ],
    });
    const result = investigateConfig(context, noSeeds);
    // Should still report because my-postgres/redis-cache aren't in 'default'
    expect(result.findings.length).toBeGreaterThan(0);
    const finding = result.findings[0]!;
    expect(finding.reasoningSummary.toLowerCase()).toContain("namespace 'default'");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Non-pod resources are ignored
// ---------------------------------------------------------------------------

describe('investigateConfig — non-pod resources are ignored', () => {
  it('does not process Deployment resources as pods', () => {
    const deployment: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'my-deploy', namespace: 'default' },
      spec: {
        template: {
          spec: {
            volumes: [
              { name: 'creds', secret: { secretName: 'deploy-creds' } },
            ],
            containers: [{ name: 'app', image: 'myapp:v1.0.0' }],
          },
        },
      },
      status: {},
    };
    const context = makeContext({
      resources: [deployment, makeSecret('other-secret', 'default')],
    });
    const result = investigateConfig(context, noSeeds);
    // Deployment spec is not a Pod — should not be processed for secret refs
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — Pod with multiple missing secrets produces consolidated finding
// ---------------------------------------------------------------------------

describe('investigateConfig — multiple secrets missing in one pod', () => {
  it('consolidates multiple missing secrets into a single finding per pod', () => {
    const podMultiSecret: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'multi-secret-pod', namespace: 'default' },
      spec: {
        volumes: [
          { name: 'creds', secret: { secretName: 'secret-a' } },
        ],
        containers: [
          {
            name: 'app',
            image: 'myapp:v1.0.0',
            envFrom: [
              { secretRef: { name: 'secret-b' } },
            ],
          },
        ],
      },
      status: {},
    };
    const context = makeContext({
      resources: [
        podMultiSecret,
        makeSecret('some-unrelated-secret', 'default'),
      ],
    });
    const result = investigateConfig(context, noSeeds);
    // One finding for the pod, even though two secrets are missing
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title.toLowerCase()).toContain('multi-secret-pod');
    // Both secrets should appear in affectedComponents
    const comps = result.findings[0]!.affectedComponents;
    expect(comps.some((c) => c.includes('secret-a'))).toBe(true);
    expect(comps.some((c) => c.includes('secret-b'))).toBe(true);
  });
});
