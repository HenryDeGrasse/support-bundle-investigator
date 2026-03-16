import type { K8sEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective timestamp for an event as a number (ms since epoch),
 * or `undefined` if no timestamp is present.
 *
 * We prefer `firstTimestamp` because it records when the event first
 * occurred, giving a more accurate chronological position than
 * `lastTimestamp` (which may be much later for repeated events).
 */
function getTimestampMs(event: K8sEvent): number | undefined {
  const ts = event.firstTimestamp ?? event.lastTimestamp;
  if (!ts) return undefined;

  const ms = Date.parse(ts);
  return isNaN(ms) ? undefined : ms;
}

// ---------------------------------------------------------------------------
// sortEventsByTime
// ---------------------------------------------------------------------------

/**
 * Returns a new array of events sorted chronologically by `firstTimestamp`
 * (falling back to `lastTimestamp` when `firstTimestamp` is absent).
 *
 * Events without any timestamp are stable-sorted to the **end** of the
 * array, preserving their relative order from the input.
 *
 * The original array is **not** mutated.
 */
export function sortEventsByTime(events: K8sEvent[]): K8sEvent[] {
  return [...events].sort((a, b) => {
    const ta = getTimestampMs(a);
    const tb = getTimestampMs(b);

    if (ta === undefined && tb === undefined) return 0;
    if (ta === undefined) return 1;   // a → end
    if (tb === undefined) return -1;  // b → end

    return ta - tb;
  });
}

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

/**
 * Merges multiple arrays of {@link K8sEvent} (e.g. from different
 * namespaces or files) into a single chronologically-sorted array.
 *
 * Events without timestamps are appended after all timestamped events,
 * preserving their relative order across the original sets.
 */
export function buildTimeline(eventSets: K8sEvent[][]): K8sEvent[] {
  const merged = eventSets.flat();
  return sortEventsByTime(merged);
}

// ---------------------------------------------------------------------------
// filterEventsByType
// ---------------------------------------------------------------------------

/**
 * Returns only the events whose `type` field equals the specified value
 * (`'Warning'` or `'Normal'`).
 */
export function filterEventsByType(
  events: K8sEvent[],
  type: 'Warning' | 'Normal',
): K8sEvent[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// filterEventsByObject
// ---------------------------------------------------------------------------

/**
 * Returns only the events whose `involvedObject.kind` and
 * `involvedObject.name` both match the given values (case-sensitive).
 */
export function filterEventsByObject(
  events: K8sEvent[],
  kind: string,
  name: string,
): K8sEvent[] {
  return events.filter(
    (e) => e.involvedObject.kind === kind && e.involvedObject.name === name,
  );
}

// ---------------------------------------------------------------------------
// getEventWindow
// ---------------------------------------------------------------------------

/**
 * Returns events whose effective timestamp falls within the closed interval
 * `[start, end]`.
 *
 * Events without a parseable timestamp are **excluded** from the window.
 */
export function getEventWindow(
  events: K8sEvent[],
  start: Date,
  end: Date,
): K8sEvent[] {
  const startMs = start.getTime();
  const endMs = end.getTime();

  return events.filter((e) => {
    const ts = getTimestampMs(e);
    if (ts === undefined) return false;
    return ts >= startMs && ts <= endMs;
  });
}

// ---------------------------------------------------------------------------
// correlateEventsWithPod
// ---------------------------------------------------------------------------

/**
 * Returns events that are directly associated with a specific pod.
 *
 * An event is considered correlated when:
 * - `involvedObject.kind === 'Pod'`
 * - `involvedObject.name === podName`
 */
export function correlateEventsWithPod(
  events: K8sEvent[],
  podName: string,
): K8sEvent[] {
  return events.filter(
    (e) => e.involvedObject.kind === 'Pod' && e.involvedObject.name === podName,
  );
}
