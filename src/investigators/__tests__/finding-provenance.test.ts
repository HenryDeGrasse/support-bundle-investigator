import { describe, expect, it, vi } from 'vitest';
import type {
  BundleProfile,
  Finding,
  K8sEvent,
  K8sResource,
} from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import type {
  InvestigatorContext,
  InvestigationSeed,
} from '../types.js';
import { investigateKubernetes } from '../kubernetes-investigator.js';
import { investigateLog } from '../log-investigator.js';
import { investigateConfig } from '../config-investigator.js';
import { investigateServices } from '../service-investigator.js';
import { investigateNetworkPolicies } from '../network-policy-investigator.js';
import { convertHypothesisToFinding } from '../hypothesis-converter.js';
import { investigateWithAI } from '../ai-investigator.js';
import { verifyFindings } from '../verifier.js';
import {
  __testOnlyPass1ComponentMerge,
  __testOnlyPass2TitleDedup,
  runInvestigation,
} from '../orchestrator.js';
import type { Hypothesis } from '../hypothesis-types.js';
import type { IndexedChunk } from '../../ai/chunk-indexer.js';
import type { ResourceRelationshipGraph } from '../../graph/resource-graph.js';
import type { AIInvestigatorDeps } from '../ai-investigator.js';

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
    logs: [],
    profile: makeProfile(),
    ...partial,
  };
}

function makeSeed(
  id: string,
  category: InvestigationSeed['category'],
  source: string,
  hypothesis = 'test hypothesis',
  priority = 80,
): InvestigationSeed {
  return { id, category, source, hypothesis, priority };
}

function makeLogFile(path: string, contents: string[]): LogFile {
  const lines: LogLine[] = contents.map((content, index) => ({
    lineNumber: index + 1,
    content,
    level: content.toLowerCase().includes('error') ? 'error' : 'info',
  }));

  return {
    path,
    lines,
    errorCount: lines.filter((line) => line.level === 'error').length,
    warningCount: 0,
    importance: 0.7,
  };
}

function makeFinding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'title'>): Finding {
  return {
    id: overrides.id,
    title: overrides.title,
    severity: overrides.severity ?? 'high',
    confidence: overrides.confidence ?? 0.7,
    affectedComponents: overrides.affectedComponents ?? ['Pod/default/app-pod'],
    reasoningSummary: overrides.reasoningSummary ?? 'Test reasoning',
    evidence: overrides.evidence ?? [{ path: 'cluster-resources/pods/default/app-pod.yaml', note: 'pod evidence' }],
    contradictionsChecked: overrides.contradictionsChecked ?? [],
    recommendedAction: overrides.recommendedAction ?? 'Investigate',
    missingEvidence: overrides.missingEvidence ?? [],
    confidenceQuality: overrides.confidenceQuality,
    provenance: overrides.provenance,
  };
}

const crashLoopPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        envFrom: [{ secretRef: { name: 'app-secret' } }],
      },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
    containerStatuses: [
      {
        name: 'app',
        ready: false,
        restartCount: 7,
        state: {
          waiting: {
            reason: 'CrashLoopBackOff',
            message: 'back-off restarting failed container',
          },
        },
      },
    ],
  },
};

const backOffEvent: K8sEvent = {
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container app in pod app-pod_default(uid)',
  involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
  count: 7,
  firstTimestamp: '2024-01-15T10:00:00Z',
  lastTimestamp: '2024-01-15T10:05:00Z',
};

const failedMountEvent: K8sEvent = {
  type: 'Warning',
  reason: 'FailedMount',
  message: 'MountVolume.SetUp failed for volume "app-secret": secret "app-secret" not found',
  involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
  count: 7,
  firstTimestamp: '2024-01-15T10:00:10Z',
  lastTimestamp: '2024-01-15T10:05:10Z',
};

const dnsLog = makeLogFile('pods/default/app/app.log', [
  '2024-01-15T10:00:00Z INFO starting',
  '2024-01-15T10:00:01Z ERROR lookup db.internal: no such host',
  '2024-01-15T10:00:02Z ERROR lookup db.internal: no such host',
]);

const dnsPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        env: [{ name: 'DB_HOST', value: 'db.internal' }],
      },
    ],
  },
  status: {},
};

const envRefPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'cfg-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        env: [{ name: 'DB_HOST', value: 'missing-db' }],
      },
    ],
  },
  status: {},
};

const unrelatedService: K8sResource = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'other-service', namespace: 'default' },
  spec: { selector: { app: 'other-service' } },
  status: {},
};

const serviceResource: K8sResource = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'api-service', namespace: 'default' },
  spec: { selector: { app: 'api' }, ports: [{ port: 80, targetPort: 8080 }] },
  status: {},
};

const serviceConsumerPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'consumer-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.0.0',
        env: [{ name: 'SERVICE_HOST', value: 'api-service' }],
      },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
  },
};

const networkPolicyPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'client-pod', namespace: 'default', labels: { app: 'client' } },
  spec: { containers: [{ name: 'app', image: 'myapp:v1.0.0' }] },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
  },
};

const networkPolicyService: K8sResource = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'payments-api', namespace: 'default' },
  spec: {
    selector: { app: 'payments' },
    ports: [{ port: 80, protocol: 'TCP' }],
  },
  status: {},
};

const blockAllEgressPolicy: K8sResource = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name: 'deny-all-egress', namespace: 'default' },
  spec: {
    podSelector: { matchLabels: { app: 'client' } },
    policyTypes: ['Egress'],
    egress: [],
  },
  status: {},
};

function makeHypothesis(): Hypothesis {
  return {
    id: 'pod-crashloop:default/app-pod:missing-secret',
    symptom: "Pod 'app-pod' is in CrashLoopBackOff in namespace 'default'",
    rootCause: 'Missing secret prevents startup',
    category: 'missing-secret',
    confidence: 0.8,
    confidenceRationale: 'Supporting evidence strongly favors missing-secret.',
    evidenceAssessment: {
      supporting: [
        {
          path: 'cluster-resources/events/default.json',
          note: 'FailedMount event references app-secret',
          artifactType: 'event',
        },
      ],
      contradicting: [],
      missingDecisive: [],
    },
    specGapRecommendations: [],
    sourceFindings: ['finding:k8s:crashloop:0'],
  };
}

function makeAIDeps(chunkIndex: IndexedChunk[]): AIInvestigatorDeps {
  const resourceGraph: ResourceRelationshipGraph = { nodes: new Map(), edges: [] };

  return {
    llmClient: {
      investigateSeed: vi.fn().mockResolvedValue({
        findings: [
          {
            title: 'Missing Secret causes startup failure',
            severity: 'critical',
            confidence: 0.9,
            affectedComponents: ['Pod/default/app-pod'],
            reasoningSummary: 'The pod references a missing secret and cannot start.',
            evidence: [
              {
                path: 'cluster-resources/pods/default/app-pod.yaml',
                note: 'Pod references missing secret app-secret',
                lineRange: [1, 20],
              },
            ],
            contradictionsChecked: [],
            recommendedAction: 'Create the missing secret.',
            missingEvidence: [],
          },
        ],
        rawResponse: '{}',
      }),
    } as unknown as AIInvestigatorDeps['llmClient'],
    chunkIndex,
    resourceGraph,
    lexicalIndex: {
      build: vi.fn(),
      search: vi.fn().mockReturnValue([]),
      extractQueryIdentifiers: vi.fn().mockReturnValue([]),
    } as unknown as AIInvestigatorDeps['lexicalIndex'],
  };
}

describe('finding provenance', () => {
  it('stamps kubernetes findings with investigator and matching seed identity', () => {
    const seed = makeSeed('seed:pod:0', 'kubernetes', 'pod:default/app-pod');
    const result = investigateKubernetes(
      makeContext({ resources: [crashLoopPod], events: [backOffEvent] }),
      [seed],
    );

    const finding = result.findings.find((item) => item.id.startsWith('finding:k8s:crashloop:'));
    expect(finding?.provenance?.investigator).toBe('kubernetes');
    expect(finding?.provenance?.seedId).toBe(seed.id);
    expect(finding?.provenance?.seedSource).toBe(seed.source);
    expect(finding?.provenance?.generatedAt).toBeTruthy();
  });

  it('stamps log findings with investigator and matching log seed identity', () => {
    const seed = makeSeed('seed:log:0', 'log', `log:${dnsLog.path}`);
    const result = investigateLog(
      makeContext({ logs: [dnsLog], resources: [dnsPod] }),
      [seed],
    );

    expect(result.findings[0]?.provenance?.investigator).toBe('log');
    expect(result.findings[0]?.provenance?.seedId).toBe(seed.id);
    expect(result.findings[0]?.provenance?.seedSource).toBe(seed.source);
  });

  it('stamps config findings with config provenance', () => {
    const result = investigateConfig(
      makeContext({ resources: [envRefPod, unrelatedService] }),
      [],
    );

    expect(result.findings[0]?.provenance?.investigator).toBe('config');
    expect(result.findings[0]?.provenance?.generatedAt).toBeTruthy();
  });

  it('stamps service findings with service provenance', () => {
    const result = investigateServices(
      makeContext({ resources: [serviceResource, serviceConsumerPod] }),
      [],
    );

    expect(result.findings[0]?.provenance?.investigator).toBe('service');
    expect(result.findings[0]?.provenance?.generatedAt).toBeTruthy();
  });

  it('stamps network-policy findings with network-policy provenance', () => {
    const result = investigateNetworkPolicies(
      makeContext({ resources: [networkPolicyPod, networkPolicyService, blockAllEgressPolicy] }),
      [],
    );

    expect(result.findings[0]?.provenance?.investigator).toBe('network-policy');
    expect(result.findings[0]?.provenance?.generatedAt).toBeTruthy();
  });

  it('stamps hypothesis findings with hypothesis provenance and family', () => {
    const finding = convertHypothesisToFinding(makeHypothesis(), 1);

    expect(finding.provenance?.investigator).toBe('hypothesis');
    expect(finding.provenance?.hypothesisFamily).toBe('missing-secret');
    expect(finding.provenance?.generatedAt).toBeTruthy();
  });

  it('stamps AI findings with AI provenance and seed identity', async () => {
    const seed = makeSeed('seed:merged:3', 'kubernetes', 'pod:default/app-pod');
    const chunkIndex: IndexedChunk[] = [
      {
        id: 'chunk:0',
        artifactId: 'cluster-resources/pods/default/app-pod.yaml',
        content: 'pod references secret app-secret',
        summary: 'pod summary',
        startLine: 1,
        endLine: 20,
        identifiers: [],
        artifactCategory: 'kubernetes-resource',
      },
    ];

    const result = await investigateWithAI(
      makeContext(),
      [seed],
      makeAIDeps(chunkIndex),
    );

    expect(result.findings[0]?.provenance?.investigator).toBe('ai');
    expect(result.findings[0]?.provenance?.seedId).toBe(seed.id);
    expect(result.findings[0]?.provenance?.seedSource).toBe(seed.source);
  });

  it('records confidenceDelta in verifier provenance', () => {
    const verified = verifyFindings(
      [
        makeFinding({
          id: 'finding:k8s:crashloop:0',
          title: 'CrashLoopBackOff: Pod app-pod',
          confidence: 0.8,
          evidence: [{ path: 'cluster-resources/pods/default/app-pod.yaml', note: 'crashloop' }],
          provenance: {
            investigator: 'kubernetes',
            generatedAt: '2024-01-01T00:00:00.000Z',
          },
        }),
      ],
      makeContext({ resources: [crashLoopPod] }),
    );

    expect(verified[0]?.provenance?.confidenceDelta).toBeDefined();
    expect(typeof verified[0]?.provenance?.confidenceDelta).toBe('number');
  });

  it('records mergedFrom when pass 1 absorbs lower-priority findings', () => {
    const heuristic = makeFinding({
      id: 'finding:config:0',
      title: 'Missing Secret app-secret',
      affectedComponents: ['Pod/default/app-pod'],
      provenance: { investigator: 'config', generatedAt: '2024-01-01T00:00:00.000Z' },
    });
    const hypothesis = makeFinding({
      id: 'finding:hypothesis:missing-secret:0',
      title: '[Hypothesis] Missing Secret app-secret (symptom: Pod/default/app-pod)',
      confidence: 0.9,
      affectedComponents: ['Pod/default/app-pod'],
      provenance: { investigator: 'hypothesis', generatedAt: '2024-01-01T00:00:00.000Z' },
    });

    const merged = __testOnlyPass1ComponentMerge([heuristic], [hypothesis]);
    expect(merged[0]?.provenance?.mergedFrom).toContain(heuristic.id);
  });

  it('records mergedFrom when pass 2 title dedup drops a duplicate finding', () => {
    const retained = makeFinding({
      id: 'finding:ai:0',
      title: 'Missing Secret app-secret',
      confidence: 0.9,
      provenance: { investigator: 'ai', generatedAt: '2024-01-01T00:00:00.000Z' },
    });
    const duplicate = makeFinding({
      id: 'finding:config:1',
      title: 'Missing Secret app-secret',
      confidence: 0.5,
      provenance: { investigator: 'config', generatedAt: '2024-01-01T00:00:00.000Z' },
    });

    const deduped = __testOnlyPass2TitleDedup([retained, duplicate]);
    expect(deduped[0]?.provenance?.mergedFrom).toContain(duplicate.id);
  });

  it('stamps graph-causal findings with graph-causal provenance', async () => {
    const result = await runInvestigation(
      makeContext({
        resources: [crashLoopPod],
        events: [backOffEvent, failedMountEvent],
      }),
    );

    const graphFinding = result.findings.find((finding) => finding.provenance?.investigator === 'graph-causal');
    expect(graphFinding).toBeDefined();
    expect(graphFinding?.provenance?.generatedAt).toBeTruthy();
    expect(graphFinding?.provenance?.hypothesisFamily).toBeTruthy();
  });
});
