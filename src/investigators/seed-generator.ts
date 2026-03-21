import type { InvestigationSeed, InvestigatorContext, SeedCategory } from './types.js';
import { extractPodStatus, getContainerErrors } from '../parsers/index.js';
import type { AnalyzerResult, K8sEvent, K8sResource } from '../types/index.js';
import type { LogFile } from '../parsers/index.js';

// ---------------------------------------------------------------------------
// Internal type guard
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Priority constants  (0–100 range; higher = more urgent)
// ---------------------------------------------------------------------------

/** Pod is looping on crash — highest urgency */
const PRIORITY_CRASHLOOP = 90;
/** Pod is stuck on image pull — highest urgency */
const PRIORITY_IMAGE_PULL = 90;
/** Analyzer reported an error-severity finding */
const PRIORITY_ERROR_ANALYZER = 80;
/** Node is NotReady — affects all pod scheduling on that node */
const PRIORITY_NODE_NOT_READY = 85;
/** Analyzer reported a warn-severity finding */
const PRIORITY_WARN_ANALYZER = 60;
/** Node has a pressure condition (MemoryPressure, DiskPressure, PIDPressure) */
const PRIORITY_NODE_PRESSURE = 70;
/** Node taint may block pod scheduling */
const PRIORITY_NODE_TAINT = 75;
/** Pod is not ready but not crashing or pulling */
const PRIORITY_POD_NOT_READY = 50;
/** Base priority for a high-importance log file seed */
const PRIORITY_HIGH_LOG_BASE = 45;
/** Warning Kubernetes event */
const PRIORITY_WARNING_EVENT = 30;

/** Minimum log importance score [0, 1] required to produce a log seed */
const LOG_IMPORTANCE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infers the {@link SeedCategory} from an analyzer result by matching
 * keywords in the name, title, and message.
 */
function categoryFromAnalyzer(result: AnalyzerResult): SeedCategory {
  const text = `${result.name} ${result.title} ${result.message}`.toLowerCase();

  if (/database|endpoint|connectivity|connection|dns|no such host|tcp|network|unreachable/.test(text)) {
    return 'connectivity';
  }
  if (/secret|credential|config|env|envfrom|mount|volume|missing/.test(text)) {
    return 'configuration';
  }
  return 'kubernetes';
}

// ---------------------------------------------------------------------------
// Source 1: Analyzer results with error / warn severity
// ---------------------------------------------------------------------------

function seedsFromAnalyzers(
  analyzerResults: AnalyzerResult[],
  makeId: (prefix: string) => string,
): InvestigationSeed[] {
  return analyzerResults
    .filter((r) => r.severity === 'error' || r.severity === 'warn')
    .map((r) => ({
      id: makeId('analyzer'),
      hypothesis: r.title || r.message || r.name,
      source: `analyzer:${r.name}`,
      category: categoryFromAnalyzer(r),
      priority: r.severity === 'error' ? PRIORITY_ERROR_ANALYZER : PRIORITY_WARN_ANALYZER,
    }));
}

// ---------------------------------------------------------------------------
// Source 2: Pod health heuristics
// ---------------------------------------------------------------------------

/**
 * Inspects every `Pod` resource and emits seeds for:
 * - CrashLoopBackOff containers (highest priority)
 * - ImagePullBackOff / ErrImagePull containers (highest priority)
 * - Not-ready pods without the above errors (medium priority)
 */
function seedsFromPods(
  resources: K8sResource[],
  makeId: (prefix: string) => string,
): InvestigationSeed[] {
  const seeds: InvestigationSeed[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Pod') continue;

    const podStatus = extractPodStatus(resource);
    if (!podStatus) continue;

    const name = resource.metadata.name;
    const ns = resource.metadata.namespace ?? 'default';
    const containerErrors = getContainerErrors(resource);

    // ── CrashLoopBackOff ────────────────────────────────────────────────────
    const crashLoop = containerErrors.find((e) => e.reason === 'CrashLoopBackOff');
    if (crashLoop) {
      seeds.push({
        id: makeId('pod'),
        hypothesis: `Pod ${name} is in CrashLoopBackOff (container: ${crashLoop.container}, namespace: ${ns})`,
        source: `pod:${ns}/${name}`,
        category: 'kubernetes',
        priority: PRIORITY_CRASHLOOP,
      });
      continue; // Don't double-count as not-ready
    }

    // ── ImagePullBackOff / ErrImagePull ─────────────────────────────────────
    const imagePull = containerErrors.find(
      (e) => e.reason === 'ImagePullBackOff' || e.reason === 'ErrImagePull',
    );
    if (imagePull) {
      seeds.push({
        id: makeId('pod'),
        hypothesis: `Pod ${name} is in ${imagePull.reason} (container: ${imagePull.container}, namespace: ${ns})`,
        source: `pod:${ns}/${name}`,
        category: 'kubernetes',
        priority: PRIORITY_IMAGE_PULL,
      });
      continue; // Don't double-count as not-ready
    }

    // ── Not-ready (readiness probe failure, dependency issue, etc.) ──────────
    const readyCond = podStatus.conditions.find((c) => c.type === 'Ready');
    if (readyCond && readyCond.status === 'False') {
      seeds.push({
        id: makeId('pod'),
        hypothesis: `Pod ${name} is not ready in namespace ${ns}`,
        source: `pod:${ns}/${name}`,
        category: 'kubernetes',
        priority: PRIORITY_POD_NOT_READY,
      });
    }
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Source 3: High-importance log files
// ---------------------------------------------------------------------------

/**
 * Emits a log seed for any log file whose importance score meets the
 * {@link LOG_IMPORTANCE_THRESHOLD}.  Priority is scaled slightly above the
 * base value when the log is extremely dense with errors.
 */
function seedsFromLogs(
  logs: LogFile[],
  makeId: (prefix: string) => string,
): InvestigationSeed[] {
  return logs
    .filter((l) => l.importance >= LOG_IMPORTANCE_THRESHOLD)
    .map((l) => ({
      id: makeId('log'),
      hypothesis: `Log file ${l.path} contains significant errors or warnings (importance: ${l.importance.toFixed(2)})`,
      source: `log:${l.path}`,
      category: 'log' as SeedCategory,
      // Scale up to PRIORITY_HIGH_LOG_BASE + 10 for importance=1.0
      priority: Math.round(PRIORITY_HIGH_LOG_BASE + l.importance * 10),
    }));
}

// ---------------------------------------------------------------------------
// Source 4: Warning events
// ---------------------------------------------------------------------------

function seedsFromEvents(
  events: K8sEvent[],
  makeId: (prefix: string) => string,
): InvestigationSeed[] {
  return events
    .filter((e) => e.type === 'Warning')
    .map((e) => ({
      id: makeId('event'),
      hypothesis: `Kubernetes warning event: ${e.reason} on ${e.involvedObject.kind}/${e.involvedObject.name}: ${e.message.slice(0, 100)}`,
      source: `event:${e.reason}:${e.involvedObject.name}`,
      category: 'kubernetes' as SeedCategory,
      priority: PRIORITY_WARNING_EVENT,
    }));
}

// ---------------------------------------------------------------------------
// Source 5: Node health conditions
// ---------------------------------------------------------------------------

/**
 * Scans Node resources for unhealthy conditions and blocking taints and emits
 * seeds for:
 * - `Ready=False`         (NodeNotReady — highest node-level urgency)
 * - `MemoryPressure=True` (memory pressure on the node)
 * - `DiskPressure=True`   (disk pressure on the node)
 * - `PIDPressure=True`    (PID pressure on the node)
 * - `NoSchedule/NoExecute` taints that may block pod scheduling
 *
 * Healthy, untainted nodes produce no seeds.
 */
function seedsFromNodes(
  resources: K8sResource[],
  makeId: (prefix: string) => string,
): InvestigationSeed[] {
  const seeds: InvestigationSeed[] = [];

  for (const resource of resources) {
    if (resource.kind !== 'Node') continue;
    if (!isRecord(resource.status)) continue;

    const nodeName = resource.metadata.name;
    const rawConditions = resource.status['conditions'];
    if (!Array.isArray(rawConditions)) continue;

    for (const rawCond of rawConditions) {
      if (!isRecord(rawCond)) continue;
      const type = typeof rawCond['type'] === 'string' ? rawCond['type'] : '';
      const status = typeof rawCond['status'] === 'string' ? rawCond['status'] : '';

      if (type === 'Ready' && status === 'False') {
        seeds.push({
          id: makeId('node'),
          hypothesis: `Node ${nodeName} is NotReady — pods cannot be scheduled or will be evicted`,
          source: `node:${nodeName}`,
          category: 'kubernetes',
          priority: PRIORITY_NODE_NOT_READY,
        });
      } else if (type === 'MemoryPressure' && status === 'True') {
        seeds.push({
          id: makeId('node'),
          hypothesis: `Node ${nodeName} has MemoryPressure — pods may be throttled or evicted`,
          source: `node:${nodeName}`,
          category: 'kubernetes',
          priority: PRIORITY_NODE_PRESSURE,
        });
      } else if (type === 'DiskPressure' && status === 'True') {
        seeds.push({
          id: makeId('node'),
          hypothesis: `Node ${nodeName} has DiskPressure — pods may fail to start due to insufficient disk space`,
          source: `node:${nodeName}`,
          category: 'kubernetes',
          priority: PRIORITY_NODE_PRESSURE,
        });
      } else if (type === 'PIDPressure' && status === 'True') {
        seeds.push({
          id: makeId('node'),
          hypothesis: `Node ${nodeName} has PIDPressure — new processes may fail to start`,
          source: `node:${nodeName}`,
          category: 'kubernetes',
          priority: PRIORITY_NODE_PRESSURE,
        });
      }
    }

    if (isRecord(resource.spec)) {
      const rawTaints = resource.spec['taints'];
      if (Array.isArray(rawTaints)) {
        for (const rawTaint of rawTaints) {
          if (!isRecord(rawTaint)) continue;
          const key = typeof rawTaint['key'] === 'string' ? rawTaint['key'] : '';
          const effect = typeof rawTaint['effect'] === 'string' ? rawTaint['effect'] : '';
          const value = typeof rawTaint['value'] === 'string' ? rawTaint['value'] : undefined;
          if (!key || (effect !== 'NoSchedule' && effect !== 'NoExecute')) continue;

          const taintLabel = value ? `${key}=${value}` : key;
          seeds.push({
            id: makeId('node'),
            hypothesis:
              `Node ${nodeName} has taint ${taintLabel}:${effect} — pods without a matching toleration may fail to schedule`,
            source: `node:${nodeName}`,
            category: 'kubernetes',
            priority: PRIORITY_NODE_TAINT,
          });
        }
      }
    }
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates investigation seeds from all available sources in the context.
 *
 * Seeds are created from five sources:
 * 1. Analyzer results with `error` or `warn` severity
 * 2. Pod health heuristics (CrashLoopBackOff, ImagePullBackOff, not-ready)
 * 3. Log files whose importance score exceeds the threshold
 * 4. Warning-type Kubernetes events
 * 5. Node health conditions and blocking taints (NotReady, pressure conditions, NoSchedule/NoExecute)
 *
 * The returned array is sorted by {@link InvestigationSeed.priority}
 * descending — highest-priority (most actionable) seeds come first.
 */
export function generateSeeds(context: InvestigatorContext): InvestigationSeed[] {
  let counter = 0;
  const makeId = (prefix: string): string => `seed:${prefix}:${counter++}`;

  const seeds: InvestigationSeed[] = [
    ...seedsFromAnalyzers(context.analyzerResults, makeId),
    ...seedsFromPods(context.resources, makeId),
    ...seedsFromNodes(context.resources, makeId),
    ...seedsFromLogs(context.logs, makeId),
    ...seedsFromEvents(context.events, makeId),
  ];

  // Sort by priority descending (highest first)
  return seeds.sort((a, b) => b.priority - a.priority);
}
