import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { parseEventFile, parseEventsJson, parseEventsYaml } from '../event-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCENARIOS = path.resolve(__dirname, '../../../test/fixtures/scenarios');

const BAD_IMAGE_EVENTS = path.join(
  SCENARIOS,
  'bad-image-tag',
  'cluster-resources',
  'events',
  'default.json',
);
const CRASHLOOP_EVENTS = path.join(
  SCENARIOS,
  'missing-secret-crashloop',
  'cluster-resources',
  'events',
  'default.json',
);

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const SIMPLE_EVENT_ARRAY_JSON = JSON.stringify([
  {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: 'evt-1', namespace: 'default' },
    involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 'default' },
    reason: 'Failed',
    message: 'Image pull failed',
    type: 'Warning',
    count: 3,
    firstTimestamp: '2024-01-15T10:00:00Z',
    lastTimestamp: '2024-01-15T10:05:00Z',
  },
  {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: 'evt-2', namespace: 'default' },
    involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 'default' },
    reason: 'Pulling',
    message: 'Pulling image',
    type: 'Normal',
    count: 1,
    firstTimestamp: '2024-01-15T09:59:00Z',
    lastTimestamp: '2024-01-15T09:59:00Z',
  },
]);

const EVENT_LIST_JSON = JSON.stringify({
  apiVersion: 'v1',
  kind: 'EventList',
  metadata: { resourceVersion: '123' },
  items: [
    {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'evt-list-1', namespace: 'kube-system' },
      involvedObject: { kind: 'Deployment', name: 'coredns', namespace: 'kube-system' },
      reason: 'ScalingReplicaSet',
      message: 'Scaled up replica set coredns-abc to 1',
      type: 'Normal',
      count: 1,
      firstTimestamp: '2024-01-15T08:00:00Z',
      lastTimestamp: '2024-01-15T08:00:00Z',
    },
    {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'evt-list-2', namespace: 'kube-system' },
      involvedObject: { kind: 'Pod', name: 'coredns-abc-xyz', namespace: 'kube-system' },
      reason: 'Scheduled',
      message: 'Successfully assigned kube-system/coredns-abc-xyz to node-1',
      type: 'Normal',
      count: 1,
      firstTimestamp: '2024-01-15T08:00:05Z',
      lastTimestamp: '2024-01-15T08:00:05Z',
    },
  ],
});

const SIMPLE_EVENT_YAML = `\
apiVersion: v1
kind: Event
metadata:
  name: yaml-evt-1
  namespace: production
involvedObject:
  kind: Pod
  name: web-pod
  namespace: production
reason: OOMKilled
message: Container exceeded memory limit
type: Warning
count: 2
firstTimestamp: "2024-01-15T12:00:00Z"
lastTimestamp: "2024-01-15T12:10:00Z"
`;

const EVENT_LIST_YAML = `\
apiVersion: v1
kind: EventList
metadata:
  resourceVersion: "456"
items:
  - apiVersion: v1
    kind: Event
    metadata:
      name: yaml-list-evt-1
      namespace: staging
    involvedObject:
      kind: Deployment
      name: frontend
      namespace: staging
    reason: RollingUpdate
    message: Deployment has minimum availability
    type: Normal
    count: 1
    firstTimestamp: "2024-01-15T09:00:00Z"
    lastTimestamp: "2024-01-15T09:00:00Z"
  - apiVersion: v1
    kind: Event
    metadata:
      name: yaml-list-evt-2
      namespace: staging
    involvedObject:
      kind: Pod
      name: frontend-abc-123
      namespace: staging
    reason: Pulled
    message: Successfully pulled image
    type: Normal
    count: 1
    firstTimestamp: "2024-01-15T09:01:00Z"
    lastTimestamp: "2024-01-15T09:01:00Z"
`;

const EVENT_MISSING_TIMESTAMPS_JSON = JSON.stringify([
  {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: 'no-ts-evt', namespace: 'default' },
    involvedObject: { kind: 'Node', name: 'node-1' },
    reason: 'NodeNotReady',
    message: 'Node condition is NotReady',
    type: 'Warning',
    count: 1,
    // no firstTimestamp or lastTimestamp
  },
]);

const MALFORMED_EVENT_JSON = '{ this is not: valid json [';

const EMPTY_ARRAY_JSON = '[]';

// ---------------------------------------------------------------------------
// parseEventsJson
// ---------------------------------------------------------------------------

describe('parseEventsJson', () => {
  it('parses a raw JSON array of events into K8sEvent[]', () => {
    const events = parseEventsJson(SIMPLE_EVENT_ARRAY_JSON);

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('Warning');
    expect(events[0]?.reason).toBe('Failed');
    expect(events[0]?.message).toBe('Image pull failed');
  });

  it('extracts type, reason, message, involvedObject, timestamps, count', () => {
    const events = parseEventsJson(SIMPLE_EVENT_ARRAY_JSON);
    const evt = events[0]!;

    expect(evt.type).toBe('Warning');
    expect(evt.reason).toBe('Failed');
    expect(evt.message).toBe('Image pull failed');
    expect(evt.involvedObject).toEqual({ kind: 'Pod', name: 'my-pod', namespace: 'default' });
    expect(evt.firstTimestamp).toBe('2024-01-15T10:00:00Z');
    expect(evt.lastTimestamp).toBe('2024-01-15T10:05:00Z');
    expect(evt.count).toBe(3);
  });

  it('handles EventList wrapper format — unwraps items', () => {
    const events = parseEventsJson(EVENT_LIST_JSON);

    expect(events).toHaveLength(2);
    expect(events[0]?.reason).toBe('ScalingReplicaSet');
    expect(events[1]?.reason).toBe('Scheduled');
    expect(events[0]?.involvedObject.kind).toBe('Deployment');
    expect(events[0]?.involvedObject.name).toBe('coredns');
  });

  it('handles missing timestamps gracefully — fields are undefined', () => {
    const events = parseEventsJson(EVENT_MISSING_TIMESTAMPS_JSON);

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.firstTimestamp).toBeUndefined();
    expect(evt.lastTimestamp).toBeUndefined();
    expect(evt.reason).toBe('NodeNotReady');
  });

  it('handles malformed JSON gracefully — returns empty array and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const events = parseEventsJson(MALFORMED_EVENT_JSON);

    expect(events).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('handles empty event array — returns empty array', () => {
    const events = parseEventsJson(EMPTY_ARRAY_JSON);
    expect(events).toHaveLength(0);
    expect(Array.isArray(events)).toBe(true);
  });

  it('handles empty JSON content gracefully — returns empty array', () => {
    expect(parseEventsJson('')).toEqual([]);
    expect(parseEventsJson('   ')).toEqual([]);
  });

  it('skips malformed event records gracefully', () => {
    const json = JSON.stringify([
      {
        kind: 'Event',
        involvedObject: { kind: 'Pod', name: 'valid-pod', namespace: 'default' },
        reason: 'Scheduled',
        message: 'Assigned to node-1',
        type: 'Normal',
      },
      {
        kind: 'Event',
        reason: 'Broken',
        message: 'Missing involvedObject',
        type: 'Warning',
      },
      42,
    ]);

    const events = parseEventsJson(json);

    expect(events).toHaveLength(1);
    expect(events[0]?.involvedObject.name).toBe('valid-pod');
  });

  it('handles missing count field gracefully — count is undefined', () => {
    const json = JSON.stringify([
      {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: 'no-count', namespace: 'default' },
        involvedObject: { kind: 'Pod', name: 'some-pod' },
        reason: 'Test',
        message: 'Test message',
        type: 'Normal',
        firstTimestamp: '2024-01-15T10:00:00Z',
        lastTimestamp: '2024-01-15T10:00:00Z',
      },
    ]);

    const events = parseEventsJson(json);
    expect(events).toHaveLength(1);
    expect(events[0]?.count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseEventsYaml
// ---------------------------------------------------------------------------

describe('parseEventsYaml', () => {
  it('parses a single YAML Event document into K8sEvent[]', () => {
    const events = parseEventsYaml(SIMPLE_EVENT_YAML);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('Warning');
    expect(events[0]?.reason).toBe('OOMKilled');
    expect(events[0]?.message).toBe('Container exceeded memory limit');
  });

  it('parses YAML EventList wrapper — unwraps items', () => {
    const events = parseEventsYaml(EVENT_LIST_YAML);

    expect(events).toHaveLength(2);
    expect(events[0]?.reason).toBe('RollingUpdate');
    expect(events[1]?.reason).toBe('Pulled');
    expect(events[0]?.involvedObject.kind).toBe('Deployment');
    expect(events[0]?.involvedObject.name).toBe('frontend');
  });

  it('extracts involvedObject fields correctly from YAML', () => {
    const events = parseEventsYaml(SIMPLE_EVENT_YAML);
    const evt = events[0]!;

    expect(evt.involvedObject.kind).toBe('Pod');
    expect(evt.involvedObject.name).toBe('web-pod');
    expect(evt.involvedObject.namespace).toBe('production');
  });

  it('parses multiple YAML Event documents separated by ---', () => {
    const secondDoc = SIMPLE_EVENT_YAML
      .replace('yaml-evt-1', 'yaml-evt-2')
      .replace('web-pod', 'worker-pod');
    const multiDocYaml = `${SIMPLE_EVENT_YAML}\n---\n${secondDoc}`;

    const events = parseEventsYaml(multiDocYaml);

    expect(events).toHaveLength(2);
    expect(events[0]?.involvedObject.name).toBe('web-pod');
    expect(events[1]?.involvedObject.name).toBe('worker-pod');
  });

  it('handles empty YAML content — returns empty array', () => {
    expect(parseEventsYaml('')).toHaveLength(0);
    expect(parseEventsYaml('   ')).toHaveLength(0);
  });

  it('handles malformed YAML gracefully — returns empty array and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const events = parseEventsYaml(': invalid: yaml: [unclosed');

    expect(events).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseEventFile
// ---------------------------------------------------------------------------

describe('parseEventFile', () => {
  it('parses events JSON file into K8sEvent[]', async () => {
    const events = await parseEventFile(BAD_IMAGE_EVENTS);

    expect(events.length).toBeGreaterThan(0);
    events.forEach((e) => {
      expect(typeof e.type).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(typeof e.message).toBe('string');
      expect(e.involvedObject).toBeDefined();
    });
  });

  it('parses bad-image-tag events — has Warning events with ErrImagePull', async () => {
    const events = await parseEventFile(BAD_IMAGE_EVENTS);

    const warningEvents = events.filter((e) => e.type === 'Warning');
    expect(warningEvents.length).toBeGreaterThan(0);

    const imageError = events.find((e) => e.reason === 'ErrImagePull');
    expect(imageError).toBeDefined();
    expect(imageError?.involvedObject.kind).toBe('Pod');
  });

  it('parses missing-secret-crashloop events — has FailedMount and BackOff events', async () => {
    const events = await parseEventFile(CRASHLOOP_EVENTS);

    expect(events.length).toBeGreaterThan(0);
    const failedMount = events.find((e) => e.reason === 'FailedMount');
    expect(failedMount).toBeDefined();

    const backOff = events.find((e) => e.reason === 'BackOff');
    expect(backOff).toBeDefined();
  });

  it('extracts count from fixture events', async () => {
    const events = await parseEventFile(BAD_IMAGE_EVENTS);

    events.forEach((e) => {
      if (e.count !== undefined) {
        expect(typeof e.count).toBe('number');
      }
    });
  });

  it('returns empty array and logs warning for non-existent file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const events = await parseEventFile('/no/such/events.json');

    expect(events).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});
