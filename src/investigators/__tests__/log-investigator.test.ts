import { describe, it, expect } from 'vitest';
import type { InvestigatorContext, InvestigationSeed } from '../types.js';
import type { BundleProfile, K8sResource, K8sEvent } from '../../types/index.js';
import type { LogFile, LogLine } from '../../parsers/index.js';
import { classifyLogLevel, extractTimestamps } from '../../parsers/index.js';
import { investigateLog } from '../log-investigator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeLine(content: string, lineNumber: number): LogLine {
  const level = classifyLogLevel(content);
  const ts = extractTimestamps(content);
  const line: LogLine = { lineNumber, content, level };
  if (ts !== null) line.timestamp = ts;
  return line;
}

function makeLogFile(path: string, rawLines: string[]): LogFile {
  const lines = rawLines.map((content, idx) => makeLine(content, idx + 1));
  const errorCount = lines.filter((l) => l.level === 'error').length;
  const warningCount = lines.filter((l) => l.level === 'warning').length;
  return { path, lines, errorCount, warningCount, importance: 0 };
}

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
// Log fixtures
// ---------------------------------------------------------------------------

/** DNS resolution failure log (mirrors wrong-db-endpoint scenario). */
const dnsFailureLog = makeLogFile('pods/default/app/app-pod.log', [
  '2024-01-15T10:00:00Z INFO  Starting application v1.2.3',
  '2024-01-15T10:00:01Z INFO  Connecting to database at db.internal:5432',
  '2024-01-15T10:00:05Z ERROR dial tcp: lookup db.internal: no such host',
  '2024-01-15T10:00:06Z WARN  Retrying connection (attempt 1/3)',
  '2024-01-15T10:00:11Z ERROR dial tcp: lookup db.internal: no such host',
  '2024-01-15T10:00:16Z ERROR Failed to connect: lookup db.internal: no such host',
]);

/** Pod with DB_HOST env var pointing to the failing hostname. */
const dbPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.2.3',
        env: [
          { name: 'DB_HOST', value: 'db.internal' },
          { name: 'DB_PORT', value: '5432' },
        ],
      },
    ],
  },
  status: {},
};

/** Connection timeout log. */
const connTimeoutLog = makeLogFile('pods/default/app/app-pod.log', [
  '2024-01-15T10:00:00Z INFO  Starting application',
  '2024-01-15T10:00:01Z INFO  Connecting to redis cache',
  '2024-01-15T10:00:02Z ERROR connection refused: dial tcp 10.0.0.5:6379: connect: connection refused',
  '2024-01-15T10:00:03Z INFO  Retrying...',
  '2024-01-15T10:00:07Z ERROR context deadline exceeded while waiting for upstream service',
  '2024-01-15T10:00:08Z INFO  Retrying...',
  '2024-01-15T10:00:12Z ERROR connection refused: dial tcp 10.0.0.5:6379: connect: connection refused',
]);

/** Connection timeout log with only one occurrence (lower confidence). */
const singleConnTimeoutLog = makeLogFile('pods/staging/app/app-pod.log', [
  '2024-01-15T10:00:00Z INFO  Starting application',
  '2024-01-15T10:00:02Z ERROR connection refused: dial tcp 10.0.0.5:6379: connect: connection refused',
  '2024-01-15T10:00:03Z INFO  Falling back to in-memory cache',
]);

/** Missing secret / resource log (mirrors missing-secret-crashloop scenario). */
const missingSecretLog = makeLogFile('pods/default/app/app-pod.log', [
  '2024-01-15T13:30:00Z INFO  Starting application v1.2.3',
  '2024-01-15T13:30:01Z INFO  Loading configuration from environment',
  '2024-01-15T13:30:02Z ERROR Error: secret app-credentials not found',
  '2024-01-15T13:30:02Z ERROR     at loadSecrets (/app/src/config.js:42:11)',
  '2024-01-15T13:30:02Z FATAL Application startup failed — exiting with code 1',
]);

/** Pod that references the missing secret in envFrom. */
const secretPod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'myapp:v1.2.3',
        envFrom: [{ secretRef: { name: 'app-credentials' } }],
      },
    ],
  },
  status: {},
};

/** Pod that mounts the secret as a volume. */
const secretVolumePod: K8sResource = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'app-pod', namespace: 'default' },
  spec: {
    containers: [{ name: 'app', image: 'myapp:v1.2.3' }],
    volumes: [{ name: 'creds', secret: { secretName: 'app-credentials' } }],
  },
  status: {},
};

/** Image pull failure log (mirrors bad-image-tag scenario). */
const imagePullLog = makeLogFile('pods/default/app/app-pod.log', [
  '2024-01-15T10:00:00Z INFO  Starting application',
  '2024-01-15T10:00:01Z INFO  Pulling container image myapp:v999',
  '2024-01-15T10:00:02Z ERROR Failed to pull image "myapp:v999": rpc error: code = Unknown desc = not found',
  '2024-01-15T10:00:02Z ERROR ErrImagePull: image pull failed for myapp:v999',
  '2024-01-15T10:00:05Z WARN  Retrying image pull (attempt 1)',
  '2024-01-15T10:00:10Z ERROR ImagePullBackOff: Back-off pulling image "myapp:v999"',
]);

/** Healthy log — no matching patterns. */
const healthyLog = makeLogFile('pods/default/app/healthy.log', [
  '2024-01-15T10:00:00Z INFO  Starting application v1.0.0',
  '2024-01-15T10:00:01Z INFO  Connected to database successfully',
  '2024-01-15T10:00:02Z INFO  Listening on port 8080',
  '2024-01-15T10:00:10Z INFO  Health check passed',
  '2024-01-15T10:00:20Z INFO  Processed 100 requests',
]);

// ---------------------------------------------------------------------------
// Scenario 0 — Empty context / no logs
// ---------------------------------------------------------------------------

describe('investigateLog — empty context', () => {
  it('returns no findings for empty log array', () => {
    const context = makeContext({ logs: [] });
    const result = investigateLog(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns no findings for healthy logs with no error patterns', () => {
    const context = makeContext({ logs: [healthyLog] });
    const result = investigateLog(context, noSeeds);
    expect(result.findings).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1 — DNS resolution failures
// ---------------------------------------------------------------------------

describe('investigateLog — DNS resolution failures', () => {
  describe('with env var hostname correlation', () => {
    const context = makeContext({
      logs: [dnsFailureLog],
      resources: [dbPod],
    });
    const result = investigateLog(context, noSeeds);

    it('produces exactly one DNS finding', () => {
      const dnsFindings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('dns'),
      );
      expect(dnsFindings).toHaveLength(1);
    });

    it('finding has severity high', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.severity).toBe('high');
    });

    it('finding title references the log file path', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.title).toContain('app-pod.log');
    });

    it('confidence is ≥ 0.85 when correlated with env var hostnames', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('confidence is in [0, 1]', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    });

    it('evidence includes the log file path', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      const paths = f.evidence.map((e) => e.path);
      expect(paths.some((p) => p.includes('app-pod.log'))).toBe(true);
    });

    it('evidence note contains a line number', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(notes.some((n) => /line[s]?\s+\d+/i.test(n))).toBe(true);
    });

    it('evidence note contains the matched error content', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(notes.some((n) => n.includes('no such host') || n.includes('lookup'))).toBe(true);
    });

    it('evidence artifactType is "log"', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.evidence.every((e) => e.artifactType === 'log')).toBe(true);
    });

    it('affectedComponents uses Pod/<namespace>/<pod-name> when log maps to a known pod', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      // dnsFailureLog path is 'pods/default/app/app-pod.log', dbPod is 'app-pod' in 'default'
      expect(f.affectedComponents).toContain('Pod/default/app-pod');
    });

    it('affectedComponents includes the failing hostname', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.affectedComponents.some((c) => c.includes('db.internal'))).toBe(true);
    });

    it('contradictionsChecked is non-empty', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.contradictionsChecked.length).toBeGreaterThan(0);
    });

    it('recommendedAction is non-empty and mentions nslookup or DNS', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.recommendedAction).toBeTruthy();
      expect(f.recommendedAction.toLowerCase()).toMatch(/dns|nslookup|coredns/);
    });

    it('produces graph edges linking evidence to the finding', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      const supportEdges = result.edges.filter(
        (e) => e.target === f.id && e.type === 'supports',
      );
      expect(supportEdges.length).toBeGreaterThan(0);
    });

    it('reasoning summary mentions the correlated hostname', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.reasoningSummary).toContain('db.internal');
    });
  });

  describe('without env var correlation (no matching pod resources)', () => {
    const context = makeContext({ logs: [dnsFailureLog] });
    const result = investigateLog(context, noSeeds);

    it('still produces a DNS finding', () => {
      const dnsFindings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('dns'),
      );
      expect(dnsFindings).toHaveLength(1);
    });

    it('confidence is lower without correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      expect(f.confidence).toBeLessThan(0.85);
    });

    it('missingEvidence mentions DNS or env var correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
      const missing = f.missingEvidence.join(' ').toLowerCase();
      expect(missing).toMatch(/hostname|env|correlat/);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Connection timeout patterns
// ---------------------------------------------------------------------------

describe('investigateLog — connection timeout patterns', () => {
  describe('with 3+ occurrences (persistent issue)', () => {
    const context = makeContext({ logs: [connTimeoutLog] });
    const result = investigateLog(context, noSeeds);

    it('produces exactly one connection-timeout finding', () => {
      const connFindings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('connection'),
      );
      expect(connFindings).toHaveLength(1);
    });

    it('finding has severity high', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      expect(f.severity).toBe('high');
    });

    it('confidence is ≥ 0.80 for persistent connection failures', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      expect(f.confidence).toBeGreaterThanOrEqual(0.80);
    });

    it('confidence is in [0, 1]', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    });

    it('evidence note includes matched line content', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(
        notes.some(
          (n) => n.includes('connection refused') || n.includes('deadline exceeded'),
        ),
      ).toBe(true);
    });

    it('evidence includes line number reference', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(notes.some((n) => /line[s]?\s+\d+/i.test(n))).toBe(true);
    });

    it('reasoning summary mentions the detected pattern(s)', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      expect(f.reasoningSummary.toLowerCase()).toMatch(/connection refused|deadline exceeded|timeout/);
    });

    it('produces graph edges supporting the finding', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      const supportEdges = result.edges.filter(
        (e) => e.target === f.id && e.type === 'supports',
      );
      expect(supportEdges.length).toBeGreaterThan(0);
    });
  });

  describe('with single occurrence (lower confidence)', () => {
    const context = makeContext({ logs: [singleConnTimeoutLog] });
    const result = investigateLog(context, noSeeds);

    it('still produces a finding for a single connection error', () => {
      const connFindings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('connection'),
      );
      expect(connFindings).toHaveLength(1);
    });

    it('confidence is lower for single occurrence', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('connection'))!;
      // Single match < 3 → confidence < 0.80
      expect(f.confidence).toBeLessThan(0.80);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Missing resource / secret errors
// ---------------------------------------------------------------------------

describe('investigateLog — missing resource / secret errors', () => {
  describe('with K8s envFrom secret reference correlation', () => {
    const context = makeContext({
      logs: [missingSecretLog],
      resources: [secretPod],
    });
    const result = investigateLog(context, noSeeds);

    it('produces exactly one missing-resource finding', () => {
      const findings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('missing'),
      );
      expect(findings).toHaveLength(1);
    });

    it('finding has severity high', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.severity).toBe('high');
    });

    it('confidence is ≥ 0.85 when correlated with pod secret references', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('evidence includes the log file path', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.evidence.some((e) => e.path.includes('app-pod.log'))).toBe(true);
    });

    it('evidence note references the line with the secret error', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(
        notes.some((n) => n.includes('not found') || n.includes('app-credentials')),
      ).toBe(true);
    });

    it('evidence note contains a line number', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      const notes = f.evidence.map((e) => e.note);
      expect(notes.some((n) => /line[s]?\s+\d+/i.test(n))).toBe(true);
    });

    it('affectedComponents includes the extracted secret name', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(
        f.affectedComponents.some((c) => c.includes('app-credentials')),
      ).toBe(true);
    });

    it('reasoning summary mentions the secret and correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.reasoningSummary.toLowerCase()).toMatch(/app-credentials|secret|correlat/);
    });

    it('recommendedAction mentions secrets and kubectl get secrets', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.recommendedAction.toLowerCase()).toMatch(/secret|kubectl/);
    });

    it('produces graph edges supporting the finding', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      const supportEdges = result.edges.filter(
        (e) => e.target === f.id && e.type === 'supports',
      );
      expect(supportEdges.length).toBeGreaterThan(0);
    });
  });

  describe('with K8s volume secret reference correlation', () => {
    const context = makeContext({
      logs: [missingSecretLog],
      resources: [secretVolumePod],
    });
    const result = investigateLog(context, noSeeds);

    it('produces a finding with high confidence from volume mount correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f).toBeDefined();
      expect(f.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('without K8s resource correlation', () => {
    const context = makeContext({ logs: [missingSecretLog] });
    const result = investigateLog(context, noSeeds);

    it('still produces a finding without K8s correlation', () => {
      const findings = result.findings.filter((f) =>
        f.title.toLowerCase().includes('missing'),
      );
      expect(findings).toHaveLength(1);
    });

    it('confidence is lower without K8s correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      expect(f.confidence).toBeLessThan(0.85);
    });

    it('missingEvidence lists the secret name for correlation', () => {
      const f = result.findings.find((f) => f.title.toLowerCase().includes('missing'))!;
      const missing = f.missingEvidence.join(' ').toLowerCase();
      expect(missing).toMatch(/app-credentials|secret|k8s|kubernetes/);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Image pull failures in logs
// ---------------------------------------------------------------------------

describe('investigateLog — image pull failures', () => {
  const context = makeContext({ logs: [imagePullLog] });
  const result = investigateLog(context, noSeeds);

  it('produces exactly one image-pull finding', () => {
    const findings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('image'),
    );
    expect(findings).toHaveLength(1);
  });

  it('finding has severity critical', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.severity).toBe('critical');
  });

  it('confidence is ≥ 0.85 (patterns are highly specific)', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('confidence is in [0, 1]', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.confidence).toBeGreaterThanOrEqual(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
  });

  it('finding title references the log file and image pull', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.title.toLowerCase()).toContain('image');
    expect(f.title).toContain('app-pod.log');
  });

  it('evidence includes the log file path', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.evidence.some((e) => e.path.includes('app-pod.log'))).toBe(true);
  });

  it('evidence note contains ErrImagePull or ImagePullBackOff', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    const notes = f.evidence.map((e) => e.note);
    expect(
      notes.some((n) => n.includes('ErrImagePull') || n.includes('ImagePullBackOff') || n.includes('pull image')),
    ).toBe(true);
  });

  it('evidence note contains a line number', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    const notes = f.evidence.map((e) => e.note);
    expect(notes.some((n) => /line[s]?\s+\d+/i.test(n))).toBe(true);
  });

  it('affectedComponents includes the log file path', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.affectedComponents.some((c) => c.includes('app-pod.log'))).toBe(true);
  });

  it('affectedComponents includes the extracted image name', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.affectedComponents.some((c) => c.includes('myapp:v999'))).toBe(true);
  });

  it('contradictionsChecked confirms pattern detection', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    const checks = f.contradictionsChecked.join(' ').toLowerCase();
    expect(checks).toMatch(/errimagepull|imagepullbackoff|image pull/);
  });

  it('recommendedAction mentions image registry or pull secrets', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    expect(f.recommendedAction.toLowerCase()).toMatch(/registry|image|pull/);
  });

  it('produces graph edges supporting the finding', () => {
    const f = result.findings.find((f) => f.title.toLowerCase().includes('image'))!;
    const supportEdges = result.edges.filter(
      (e) => e.target === f.id && e.type === 'supports',
    );
    expect(supportEdges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Multiple findings from a single log file
// ---------------------------------------------------------------------------

describe('investigateLog — multiple findings from one log file', () => {
  /**
   * Log file containing both DNS failures and connection timeouts
   * (mirrors wrong-db-endpoint/logs/app/app-pod.log).
   */
  const combinedLog = makeLogFile('pods/default/app/combined.log', [
    '2024-01-15T10:00:00Z INFO  Starting application',
    '2024-01-15T10:00:05Z ERROR dial tcp: lookup db.internal: no such host',
    '2024-01-15T10:00:10Z ERROR dial tcp: lookup db.internal: no such host',
    '2024-01-15T10:00:15Z ERROR dial tcp: lookup db.internal: no such host',
    '2024-01-15T10:01:00Z ERROR connection timeout: context deadline exceeded',
    '2024-01-15T10:02:00Z ERROR connection timeout: context deadline exceeded',
    '2024-01-15T10:03:00Z ERROR connection timeout: context deadline exceeded',
  ]);

  const context = makeContext({ logs: [combinedLog] });
  const result = investigateLog(context, noSeeds);

  it('produces at least 2 findings (DNS + connection timeout)', () => {
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('includes a DNS finding', () => {
    expect(result.findings.some((f) => f.title.toLowerCase().includes('dns'))).toBe(true);
  });

  it('includes a connection timeout finding', () => {
    expect(result.findings.some((f) => f.title.toLowerCase().includes('connection'))).toBe(true);
  });

  it('all findings have non-empty evidence arrays', () => {
    for (const f of result.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('all edges have non-empty id, source, and target', () => {
    for (const edge of result.edges) {
      expect(edge.id).toBeTruthy();
      expect(edge.source).toBeTruthy();
      expect(edge.target).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Multiple log files produce separate findings
// ---------------------------------------------------------------------------

describe('investigateLog — separate findings per log file', () => {
  const log1 = makeLogFile('pods/ns-a/app/pod1.log', [
    '2024-01-15T10:00:00Z INFO  Starting',
    '2024-01-15T10:00:01Z ERROR dial tcp: lookup svc-a: no such host',
    '2024-01-15T10:00:02Z ERROR dial tcp: lookup svc-a: no such host',
    '2024-01-15T10:00:03Z ERROR dial tcp: lookup svc-a: no such host',
  ]);

  const log2 = makeLogFile('pods/ns-b/app/pod2.log', [
    '2024-01-15T10:00:00Z INFO  Starting',
    '2024-01-15T10:00:01Z ERROR dial tcp: lookup svc-b: no such host',
    '2024-01-15T10:00:02Z ERROR dial tcp: lookup svc-b: no such host',
    '2024-01-15T10:00:03Z ERROR dial tcp: lookup svc-b: no such host',
  ]);

  const context = makeContext({ logs: [log1, log2] });
  const result = investigateLog(context, noSeeds);

  it('produces two separate DNS findings (one per log file)', () => {
    const dnsFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('dns'),
    );
    expect(dnsFindings).toHaveLength(2);
  });

  it('each finding references its own log file', () => {
    const dnsFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('dns'),
    );
    const paths = dnsFindings.map((f) => f.evidence[0]!.path);
    expect(paths).toContain('pods/ns-a/app/pod1.log');
    expect(paths).toContain('pods/ns-b/app/pod2.log');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Finding structural invariants
// ---------------------------------------------------------------------------

describe('investigateLog — finding structural invariants', () => {
  const context = makeContext({
    logs: [dnsFailureLog, missingSecretLog, imagePullLog],
    resources: [dbPod, secretPod],
  });
  const result = investigateLog(context, noSeeds);

  it('all findings have non-empty id strings', () => {
    for (const f of result.findings) {
      expect(typeof f.id).toBe('string');
      expect(f.id).toBeTruthy();
    }
  });

  it('all findings have ids prefixed with "finding:log:"', () => {
    for (const f of result.findings) {
      expect(f.id).toMatch(/^finding:log:/);
    }
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
        expect(ev.path).toBeTruthy();
      }
    }
  });

  it('all evidence notes contain a line number reference', () => {
    for (const f of result.findings) {
      for (const ev of f.evidence) {
        expect(/line[s]?\s+\d+/i.test(ev.note)).toBe(true);
      }
    }
  });

  it('all evidence have artifactType "log"', () => {
    for (const f of result.findings) {
      for (const ev of f.evidence) {
        expect(ev.artifactType).toBe('log');
      }
    }
  });

  it('all findings have non-empty contradictionsChecked', () => {
    for (const f of result.findings) {
      expect(f.contradictionsChecked.length).toBeGreaterThan(0);
    }
  });

  it('all findings have non-empty recommendedAction', () => {
    for (const f of result.findings) {
      expect(f.recommendedAction).toBeTruthy();
    }
  });

  it('all findings have non-empty affectedComponents', () => {
    for (const f of result.findings) {
      expect(f.affectedComponents.length).toBeGreaterThan(0);
    }
  });

  it('all edges have valid type', () => {
    const validTypes = new Set(['supports', 'contradicts', 'causes', 'correlates', 'derived-from']);
    for (const edge of result.edges) {
      expect(validTypes.has(edge.type)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Seeds parameter
// ---------------------------------------------------------------------------

describe('investigateLog — seeds parameter', () => {
  it('produces the same findings regardless of seed content', () => {
    const seeds: InvestigationSeed[] = [
      {
        id: 'seed:log:0',
        hypothesis: 'DNS failures in app log',
        source: 'log:pods/default/app/app-pod.log',
        category: 'log',
        priority: 45,
      },
    ];

    const context = makeContext({ logs: [dnsFailureLog] });
    const withSeeds = investigateLog(context, seeds);
    const withoutSeeds = investigateLog(context, noSeeds);

    expect(withSeeds.findings.length).toBe(withoutSeeds.findings.length);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Non-pod resources do not break hostname extraction
// ---------------------------------------------------------------------------

describe('investigateLog — non-pod resources ignored in hostname extraction', () => {
  it('ignores Service and Deployment resources in env var extraction', () => {
    const serviceResource: K8sResource = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'my-svc', namespace: 'default' },
      spec: {},
      status: {},
    };
    const deploymentResource: K8sResource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'my-deploy', namespace: 'default' },
      spec: { replicas: 1 },
      status: {},
    };

    // Should not throw and should still produce DNS findings from the log
    const context = makeContext({
      logs: [dnsFailureLog],
      resources: [serviceResource, deploymentResource],
    });
    const result = investigateLog(context, noSeeds);

    const dnsFindings = result.findings.filter((f) =>
      f.title.toLowerCase().includes('dns'),
    );
    expect(dnsFindings).toHaveLength(1);
    // Lower confidence — no pod env var correlation
    expect(dnsFindings[0]!.confidence).toBeLessThan(0.85);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — Pod-based affectedComponents and clean evidence paths
// ---------------------------------------------------------------------------

describe('investigateLog — Pod-based affectedComponents and clean paths', () => {
  it('affectedComponents uses Pod/<namespace>/<pod-name> when log path maps to a known pod', () => {
    const podResource: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'app-pod', namespace: 'default' },
      spec: {},
      status: {},
    };
    // Log basename 'app-pod' matches the pod resource name
    const logFile = makeLogFile('logs/app/app-pod.log', [
      '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({ logs: [logFile], resources: [podResource] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    expect(f.affectedComponents).toContain('Pod/default/app-pod');
    // Should not include the raw file path as a component
    expect(f.affectedComponents.some((c) => c.includes('.log'))).toBe(false);
  });

  it('affectedComponents falls back to cleaned path when no pod name matches', () => {
    // Log basename is 'unknown-pod', no matching Pod resource exists
    const logFile = makeLogFile('logs/app/unknown-pod.log', [
      '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({ logs: [logFile] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // No Pod component — should fall back to path-based component
    expect(f.affectedComponents.some((c) => c.startsWith('Pod/'))).toBe(false);
    expect(f.affectedComponents.some((c) => c.includes('unknown-pod.log'))).toBe(true);
  });

  it('finding title uses bundle-relative path, not absolute temp path', () => {
    // Simulate an absolute extraction path as would appear in a real bundle run
    const absPath =
      '/var/folders/tmp/sbi-bundle-XYZ/bad-image-tag/logs/app/app-pod.log';
    const logFile = makeLogFile(absPath, [
      '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({ logs: [logFile] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // Title must not start with '/' or contain the temp directory prefix
    expect(f.title).not.toMatch(/\/var\/folders|\/tmp\//);
    // Title should contain the bundle-relative portion
    expect(f.title).toContain('logs/app/app-pod.log');
  });

  it('evidence paths are bundle-relative (do not start with /)', () => {
    // Simulate an absolute extraction path
    const absPath =
      '/var/folders/tmp/sbi-bundle-XYZ/bad-image-tag/logs/app/app-pod.log';
    const logFile = makeLogFile(absPath, [
      '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({ logs: [logFile] });
    const result = investigateLog(context, noSeeds);
    for (const finding of result.findings) {
      for (const ev of finding.evidence) {
        expect(ev.path).not.toMatch(/^\//);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — Init container log path (issue 1.4)
// ---------------------------------------------------------------------------

describe('resolveLogPodComponent — init container log path (pods/logs/<ns>/<pod>/<container>.log)', () => {
  const podResource: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {},
    status: {},
  };

  it('returns Pod/<ns>/<pod> for init container log at cluster-resources/pods/logs/<ns>/<pod>/<container>.log', () => {
    // The filename is 'init-setup' (container name), not the pod name 'app-pod'.
    // resolveLogPodComponent must use the parent directory (pod name) when the
    // filename itself does not match any known pod.
    const logFile = makeLogFile(
      'cluster-resources/pods/logs/default/app-pod/init-setup.log',
      [
        '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
        '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
      ],
    );
    const context = makeContext({ logs: [logFile], resources: [podResource] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // Must resolve by parent directory (app-pod), not filename (init-setup)
    expect(f.affectedComponents).toContain('Pod/default/app-pod');
    // Must not leak the container name into the Pod component
    expect(f.affectedComponents.some((c) => c.includes('init-setup'))).toBe(false);
  });

  it('still resolves by filename for old path format logs/app/app-pod.log (backwards compat)', () => {
    // Old-style path where the filename encodes the pod name
    const logFile = makeLogFile('logs/app/app-pod.log', [
      '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({ logs: [logFile], resources: [podResource] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // Should still resolve correctly via filename match
    expect(f.affectedComponents).toContain('Pod/default/app-pod');
  });

  it('uses the namespace from the matching Pod resource (not from path segments)', () => {
    // Pod is in 'production' namespace even though path says 'default'
    const prodPod: K8sResource = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'app-pod', namespace: 'production' },
      spec: {},
      status: {},
    };
    const logFile = makeLogFile(
      'cluster-resources/pods/logs/default/app-pod/init-setup.log',
      [
        '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
        '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
      ],
    );
    const context = makeContext({ logs: [logFile], resources: [prodPod] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // Namespace comes from the Pod resource metadata, not the path
    expect(f.affectedComponents).toContain('Pod/production/app-pod');
  });

  it('falls back to cleaned path when parent directory also does not match any pod', () => {
    // Neither filename ('mystery-container') nor parent dir ('ghost-pod') matches
    const logFile = makeLogFile(
      'cluster-resources/pods/logs/default/ghost-pod/mystery-container.log',
      [
        '2024-01-15T10:00:00Z ERROR dial tcp: lookup db.internal: no such host',
        '2024-01-15T10:00:01Z ERROR dial tcp: lookup db.internal: no such host',
      ],
    );
    const context = makeContext({ logs: [logFile], resources: [podResource] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((f) => f.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // Should fall back to path-based component (no Pod match)
    expect(f.affectedComponents.some((c) => c.startsWith('Pod/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — Temporal event correlation
// ---------------------------------------------------------------------------

describe('investigateLog — temporal event correlation', () => {
  /** Pod resource whose name matches the log file basename. */
  const appPod: K8sResource = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'app-pod', namespace: 'default' },
    spec: {
      containers: [
        {
          name: 'app',
          image: 'myapp:v1',
          env: [{ name: 'DB_HOST', value: 'db.internal' }],
        },
      ],
    },
    status: {},
  };

  /**
   * BackOff event on app-pod around the same time as the DNS failure log lines.
   * firstTimestamp is within the 10-minute window of the log error at 10:00:05.
   */
  const backOffEvent: K8sEvent = {
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    firstTimestamp: '2024-01-15T10:00:05Z',
    lastTimestamp: '2024-01-15T10:00:10Z',
  };

  /** Event on a different pod — must NOT appear in app-pod's findings. */
  const otherPodEvent: K8sEvent = {
    type: 'Warning',
    reason: 'Failed',
    message: 'Something failed on other pod',
    involvedObject: { kind: 'Pod', name: 'other-pod', namespace: 'default' },
    firstTimestamp: '2024-01-15T10:00:05Z',
    lastTimestamp: '2024-01-15T10:00:10Z',
  };

  /** Event far outside the time window of the DNS errors — should be excluded. */
  const farFutureEvent: K8sEvent = {
    type: 'Warning',
    reason: 'OOMKilled',
    message: 'OOMKilled',
    involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    firstTimestamp: '2024-01-15T12:00:00Z', // 2 hours after the errors
    lastTimestamp: '2024-01-15T12:00:00Z',
  };

  // ── DNS findings with events ──────────────────────────────────────────────

  describe('DNS failure findings enriched with pod events', () => {
    const context = makeContext({
      logs: [dnsFailureLog],
      resources: [appPod],
      events: [backOffEvent, otherPodEvent],
    });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((fi) => fi.title.toLowerCase().includes('dns'))!;

    it('produces a DNS finding', () => {
      expect(f).toBeDefined();
    });

    it('includes event evidence alongside log evidence', () => {
      const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
      expect(eventEv.length).toBeGreaterThan(0);
    });

    it('event evidence has artifactType "event"', () => {
      const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
      for (const ev of eventEv) {
        expect(ev.artifactType).toBe('event');
      }
    });

    it('event evidence note references the reason and pod name', () => {
      const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
      expect(
        eventEv.some(
          (e) => e.note.includes('BackOff') || e.note.includes('app-pod'),
        ),
      ).toBe(true);
    });

    it('event evidence path includes the event reason', () => {
      const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
      expect(eventEv.some((e) => e.path.includes('BackOff'))).toBe(true);
    });

    it('does not include events from other pods', () => {
      const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
      expect(eventEv.every((e) => !e.path.includes('other-pod'))).toBe(true);
    });

    it('still has the original log evidence', () => {
      const logEv = f.evidence.filter((e) => e.artifactType === 'log');
      expect(logEv.length).toBeGreaterThan(0);
    });
  });

  // ── Connection-timeout findings with events ───────────────────────────────

  describe('connection-timeout findings enriched with pod events', () => {
    const connContext = makeContext({
      logs: [connTimeoutLog],
      resources: [appPod],
      events: [backOffEvent],
    });
    const connResult = investigateLog(connContext, noSeeds);
    const cf = connResult.findings.find((fi) =>
      fi.title.toLowerCase().includes('connection'),
    )!;

    it('produces a connection finding', () => {
      expect(cf).toBeDefined();
    });

    it('includes event evidence', () => {
      const eventEv = cf.evidence.filter((e) => e.artifactType === 'event');
      expect(eventEv.length).toBeGreaterThan(0);
    });
  });

  // ── Missing-resource findings with events ─────────────────────────────────

  describe('missing-resource findings enriched with pod events', () => {
    /**
     * Event whose timestamp is within ±5 minutes of the missing-secret log
     * errors (which occur at 2024-01-15T13:30:02Z).
     */
    const secretFailEvent: K8sEvent = {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      firstTimestamp: '2024-01-15T13:30:02Z',
      lastTimestamp: '2024-01-15T13:30:02Z',
    };

    const mrContext = makeContext({
      logs: [missingSecretLog],
      resources: [secretPod],
      events: [secretFailEvent],
    });
    const mrResult = investigateLog(mrContext, noSeeds);
    const mrf = mrResult.findings.find((fi) =>
      fi.title.toLowerCase().includes('missing'),
    )!;

    it('produces a missing-resource finding', () => {
      expect(mrf).toBeDefined();
    });

    it('includes event evidence', () => {
      const eventEv = mrf.evidence.filter((e) => e.artifactType === 'event');
      expect(eventEv.length).toBeGreaterThan(0);
    });
  });

  // ── No events → no event evidence ────────────────────────────────────────

  it('produces no event evidence when context.events is empty', () => {
    const context = makeContext({ logs: [dnsFailureLog], resources: [appPod], events: [] });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((fi) => fi.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
    expect(eventEv).toHaveLength(0);
  });

  // ── Events outside the time window are excluded ───────────────────────────

  it('excludes events outside the ±5-minute time window', () => {
    const context = makeContext({
      logs: [dnsFailureLog],
      resources: [appPod],
      events: [backOffEvent, farFutureEvent],
    });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((fi) => fi.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
    // farFutureEvent (12:00) is 2 hours away from errors (~10:00), outside ±5 min
    expect(eventEv.every((e) => !e.path.includes('OOMKilled'))).toBe(true);
    // backOffEvent (10:00:05) should still be included
    expect(eventEv.some((e) => e.path.includes('BackOff'))).toBe(true);
  });

  // ── No matching pod → no event evidence ──────────────────────────────────

  it('produces no event evidence when log path does not map to a known pod', () => {
    // logFile basename is 'ghost-pod' but no pod resource with that name exists
    const ghostLog = makeLogFile('logs/app/ghost-pod.log', [
      '2024-01-15T10:00:05Z ERROR dial tcp: lookup db.internal: no such host',
      '2024-01-15T10:00:06Z ERROR dial tcp: lookup db.internal: no such host',
    ]);
    const context = makeContext({
      logs: [ghostLog],
      resources: [],
      events: [backOffEvent],
    });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((fi) => fi.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    // No pod match → no event evidence
    const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
    expect(eventEv).toHaveLength(0);
  });

  // ── At most 5 event evidence items ───────────────────────────────────────

  it('adds at most 5 event evidence items per finding', () => {
    const manyEvents: K8sEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'Warning' as const,
      reason: `Event${i}`,
      message: `Event number ${i}`,
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      firstTimestamp: `2024-01-15T10:00:0${i < 9 ? i : '9'}Z`,
      lastTimestamp: `2024-01-15T10:00:0${i < 9 ? i : '9'}Z`,
    }));
    const context = makeContext({
      logs: [dnsFailureLog],
      resources: [appPod],
      events: manyEvents,
    });
    const result = investigateLog(context, noSeeds);
    const f = result.findings.find((fi) => fi.title.toLowerCase().includes('dns'))!;
    expect(f).toBeDefined();
    const eventEv = f.evidence.filter((e) => e.artifactType === 'event');
    expect(eventEv.length).toBeLessThanOrEqual(5);
  });
});
