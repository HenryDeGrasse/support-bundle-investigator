import { describe, it, expect } from 'vitest';
import type { K8sEvent } from '../../types/index.js';
import {
  sortEventsByTime,
  buildTimeline,
  filterEventsByType,
  filterEventsByObject,
  getEventWindow,
  correlateEventsWithPod,
} from '../timeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<K8sEvent> & { reason: string }): K8sEvent {
  return {
    type: 'Normal',
    message: 'test message',
    involvedObject: { kind: 'Pod', name: 'test-pod', namespace: 'default' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENT_T1 = makeEvent({
  reason: 'Scheduled',
  firstTimestamp: '2024-01-15T10:00:00Z',
  lastTimestamp: '2024-01-15T10:00:00Z',
});

const EVENT_T2 = makeEvent({
  reason: 'Pulling',
  type: 'Normal',
  firstTimestamp: '2024-01-15T10:01:00Z',
  lastTimestamp: '2024-01-15T10:01:00Z',
});

const EVENT_T3 = makeEvent({
  reason: 'Failed',
  type: 'Warning',
  firstTimestamp: '2024-01-15T10:02:00Z',
  lastTimestamp: '2024-01-15T10:05:00Z',
  count: 5,
});

const EVENT_NO_TIMESTAMP = makeEvent({
  reason: 'Unknown',
  type: 'Warning',
  // no firstTimestamp or lastTimestamp
});

const NAMESPACE_A_EVENTS: K8sEvent[] = [
  makeEvent({
    reason: 'Scheduled',
    firstTimestamp: '2024-01-15T09:00:00Z',
    involvedObject: { kind: 'Pod', name: 'pod-a', namespace: 'ns-a' },
  }),
  makeEvent({
    reason: 'Started',
    firstTimestamp: '2024-01-15T09:02:00Z',
    involvedObject: { kind: 'Pod', name: 'pod-a', namespace: 'ns-a' },
  }),
];

const NAMESPACE_B_EVENTS: K8sEvent[] = [
  makeEvent({
    reason: 'FailedMount',
    type: 'Warning',
    firstTimestamp: '2024-01-15T09:01:00Z',
    involvedObject: { kind: 'Pod', name: 'pod-b', namespace: 'ns-b' },
  }),
  makeEvent({
    reason: 'BackOff',
    type: 'Warning',
    firstTimestamp: '2024-01-15T09:03:00Z',
    involvedObject: { kind: 'Pod', name: 'pod-b', namespace: 'ns-b' },
  }),
];

// ---------------------------------------------------------------------------
// sortEventsByTime
// ---------------------------------------------------------------------------

describe('sortEventsByTime', () => {
  it('orders events chronologically by firstTimestamp', () => {
    const unsorted = [EVENT_T3, EVENT_T1, EVENT_T2];
    const sorted = sortEventsByTime(unsorted);

    expect(sorted[0]?.reason).toBe('Scheduled');
    expect(sorted[1]?.reason).toBe('Pulling');
    expect(sorted[2]?.reason).toBe('Failed');
  });

  it('does not mutate the original array', () => {
    const original = [EVENT_T3, EVENT_T1, EVENT_T2];
    const sorted = sortEventsByTime(original);

    expect(original[0]?.reason).toBe('Failed'); // unchanged
    expect(sorted[0]?.reason).toBe('Scheduled');
  });

  it('appends events without timestamps at the end', () => {
    const events = [EVENT_T1, EVENT_NO_TIMESTAMP, EVENT_T2];
    const sorted = sortEventsByTime(events);

    // Timestamped events come first in chronological order
    expect(sorted[0]?.reason).toBe('Scheduled');
    expect(sorted[1]?.reason).toBe('Pulling');
    // No-timestamp event is last
    expect(sorted[2]?.reason).toBe('Unknown');
  });

  it('handles an empty array', () => {
    expect(sortEventsByTime([])).toHaveLength(0);
  });

  it('handles a single event', () => {
    const sorted = sortEventsByTime([EVENT_T1]);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]?.reason).toBe('Scheduled');
  });

  it('handles events that are already sorted', () => {
    const sorted = sortEventsByTime([EVENT_T1, EVENT_T2, EVENT_T3]);
    expect(sorted[0]?.reason).toBe('Scheduled');
    expect(sorted[1]?.reason).toBe('Pulling');
    expect(sorted[2]?.reason).toBe('Failed');
  });
});

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

describe('buildTimeline', () => {
  it('merges events from multiple namespaces into a single sorted array', () => {
    const timeline = buildTimeline([NAMESPACE_A_EVENTS, NAMESPACE_B_EVENTS]);

    expect(timeline).toHaveLength(4);
    // Should be sorted chronologically
    expect(timeline[0]?.reason).toBe('Scheduled');    // 09:00
    expect(timeline[1]?.reason).toBe('FailedMount');  // 09:01
    expect(timeline[2]?.reason).toBe('Started');      // 09:02
    expect(timeline[3]?.reason).toBe('BackOff');      // 09:03
  });

  it('handles events without timestamps — appended at end', () => {
    const setWithNoTs: K8sEvent[] = [
      makeEvent({ reason: 'NoTs', firstTimestamp: undefined }),
    ];
    const timeline = buildTimeline([NAMESPACE_A_EVENTS, setWithNoTs]);

    expect(timeline).toHaveLength(3);
    expect(timeline[timeline.length - 1]?.reason).toBe('NoTs');
  });

  it('handles empty input — returns empty array', () => {
    const timeline = buildTimeline([]);
    expect(timeline).toHaveLength(0);
  });

  it('handles empty event sets within the array', () => {
    const timeline = buildTimeline([[], NAMESPACE_A_EVENTS, []]);
    expect(timeline).toHaveLength(2);
  });

  it('handles a single event set', () => {
    const timeline = buildTimeline([NAMESPACE_A_EVENTS]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.reason).toBe('Scheduled');
    expect(timeline[1]?.reason).toBe('Started');
  });
});

// ---------------------------------------------------------------------------
// filterEventsByType
// ---------------------------------------------------------------------------

describe('filterEventsByType', () => {
  const MIXED_EVENTS: K8sEvent[] = [
    makeEvent({ reason: 'Scheduled', type: 'Normal', firstTimestamp: '2024-01-15T10:00:00Z' }),
    makeEvent({ reason: 'Failed', type: 'Warning', firstTimestamp: '2024-01-15T10:01:00Z' }),
    makeEvent({ reason: 'Pulling', type: 'Normal', firstTimestamp: '2024-01-15T10:02:00Z' }),
    makeEvent({ reason: 'BackOff', type: 'Warning', firstTimestamp: '2024-01-15T10:03:00Z' }),
  ];

  it('filters Warning events', () => {
    const warnings = filterEventsByType(MIXED_EVENTS, 'Warning');
    expect(warnings).toHaveLength(2);
    expect(warnings.every((e) => e.type === 'Warning')).toBe(true);
    expect(warnings.map((e) => e.reason)).toEqual(['Failed', 'BackOff']);
  });

  it('filters Normal events', () => {
    const normals = filterEventsByType(MIXED_EVENTS, 'Normal');
    expect(normals).toHaveLength(2);
    expect(normals.every((e) => e.type === 'Normal')).toBe(true);
    expect(normals.map((e) => e.reason)).toEqual(['Scheduled', 'Pulling']);
  });

  it('returns empty array when no events match the type', () => {
    const onlyNormal: K8sEvent[] = [
      makeEvent({ reason: 'Scheduled', type: 'Normal' }),
    ];
    const warnings = filterEventsByType(onlyNormal, 'Warning');
    expect(warnings).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterEventsByType([], 'Warning')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterEventsByObject
// ---------------------------------------------------------------------------

describe('filterEventsByObject', () => {
  const MULTI_OBJECT_EVENTS: K8sEvent[] = [
    makeEvent({
      reason: 'Scheduled',
      involvedObject: { kind: 'Pod', name: 'web-pod', namespace: 'default' },
    }),
    makeEvent({
      reason: 'ScalingReplicaSet',
      involvedObject: { kind: 'Deployment', name: 'web-deploy', namespace: 'default' },
    }),
    makeEvent({
      reason: 'Failed',
      involvedObject: { kind: 'Pod', name: 'web-pod', namespace: 'default' },
    }),
    makeEvent({
      reason: 'BackOff',
      involvedObject: { kind: 'Pod', name: 'other-pod', namespace: 'default' },
    }),
  ];

  it('filters events for a specific pod', () => {
    const podEvents = filterEventsByObject(MULTI_OBJECT_EVENTS, 'Pod', 'web-pod');
    expect(podEvents).toHaveLength(2);
    expect(podEvents.every((e) => e.involvedObject.name === 'web-pod')).toBe(true);
    expect(podEvents.every((e) => e.involvedObject.kind === 'Pod')).toBe(true);
  });

  it('filters events for a specific deployment', () => {
    const deployEvents = filterEventsByObject(MULTI_OBJECT_EVENTS, 'Deployment', 'web-deploy');
    expect(deployEvents).toHaveLength(1);
    expect(deployEvents[0]?.reason).toBe('ScalingReplicaSet');
  });

  it('returns empty array when no events match', () => {
    const events = filterEventsByObject(MULTI_OBJECT_EVENTS, 'Service', 'some-svc');
    expect(events).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterEventsByObject([], 'Pod', 'any-pod')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getEventWindow
// ---------------------------------------------------------------------------

describe('getEventWindow', () => {
  const WINDOW_EVENTS: K8sEvent[] = [
    makeEvent({ reason: 'Before', firstTimestamp: '2024-01-15T09:55:00Z' }),
    makeEvent({ reason: 'Start', firstTimestamp: '2024-01-15T10:00:00Z' }),
    makeEvent({ reason: 'Middle', firstTimestamp: '2024-01-15T10:05:00Z' }),
    makeEvent({ reason: 'End', firstTimestamp: '2024-01-15T10:10:00Z' }),
    makeEvent({ reason: 'After', firstTimestamp: '2024-01-15T10:15:00Z' }),
    makeEvent({ reason: 'NoTs' }), // no timestamp, should be excluded
  ];

  const START = new Date('2024-01-15T10:00:00Z');
  const END = new Date('2024-01-15T10:10:00Z');

  it('returns events within the time range (inclusive)', () => {
    const window = getEventWindow(WINDOW_EVENTS, START, END);
    expect(window).toHaveLength(3);
    expect(window.map((e) => e.reason)).toEqual(['Start', 'Middle', 'End']);
  });

  it('excludes events before the start', () => {
    const window = getEventWindow(WINDOW_EVENTS, START, END);
    expect(window.find((e) => e.reason === 'Before')).toBeUndefined();
  });

  it('excludes events after the end', () => {
    const window = getEventWindow(WINDOW_EVENTS, START, END);
    expect(window.find((e) => e.reason === 'After')).toBeUndefined();
  });

  it('excludes events without timestamps', () => {
    const window = getEventWindow(WINDOW_EVENTS, START, END);
    expect(window.find((e) => e.reason === 'NoTs')).toBeUndefined();
  });

  it('returns empty array when no events fall in the window', () => {
    const farFuture = new Date('2030-01-01T00:00:00Z');
    const farFutureEnd = new Date('2030-01-02T00:00:00Z');
    const window = getEventWindow(WINDOW_EVENTS, farFuture, farFutureEnd);
    expect(window).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(getEventWindow([], START, END)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// correlateEventsWithPod
// ---------------------------------------------------------------------------

describe('correlateEventsWithPod', () => {
  const MIXED_POD_EVENTS: K8sEvent[] = [
    makeEvent({
      reason: 'Scheduled',
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    }),
    makeEvent({
      reason: 'Failed',
      involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
    }),
    makeEvent({
      reason: 'BackOff',
      involvedObject: { kind: 'Pod', name: 'other-pod', namespace: 'default' },
    }),
    makeEvent({
      reason: 'ScalingReplicaSet',
      involvedObject: { kind: 'Deployment', name: 'app-deploy', namespace: 'default' },
    }),
  ];

  it('matches events where involvedObject.name equals podName and kind is Pod', () => {
    const correlated = correlateEventsWithPod(MIXED_POD_EVENTS, 'app-pod');
    expect(correlated).toHaveLength(2);
    expect(correlated.every((e) => e.involvedObject.name === 'app-pod')).toBe(true);
    expect(correlated.every((e) => e.involvedObject.kind === 'Pod')).toBe(true);
  });

  it('does not return events for other pod names', () => {
    const correlated = correlateEventsWithPod(MIXED_POD_EVENTS, 'app-pod');
    expect(correlated.find((e) => e.involvedObject.name === 'other-pod')).toBeUndefined();
  });

  it('does not return non-Pod events even with matching name', () => {
    // Deployment with same name as pod — should not be returned
    const events: K8sEvent[] = [
      makeEvent({
        reason: 'ScalingReplicaSet',
        involvedObject: { kind: 'Deployment', name: 'app-pod', namespace: 'default' },
      }),
      makeEvent({
        reason: 'Scheduled',
        involvedObject: { kind: 'Pod', name: 'app-pod', namespace: 'default' },
      }),
    ];
    const correlated = correlateEventsWithPod(events, 'app-pod');
    expect(correlated).toHaveLength(1);
    expect(correlated[0]?.involvedObject.kind).toBe('Pod');
  });

  it('returns empty array when no events match the pod name', () => {
    const correlated = correlateEventsWithPod(MIXED_POD_EVENTS, 'nonexistent-pod');
    expect(correlated).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(correlateEventsWithPod([], 'app-pod')).toHaveLength(0);
  });
});
