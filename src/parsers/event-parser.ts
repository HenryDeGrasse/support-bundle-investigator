import * as fsp from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { K8sEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function hasRequiredInvolvedObjectFields(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;

  return (
    typeof value['kind'] === 'string' &&
    value['kind'].trim().length > 0 &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length > 0
  );
}

/**
 * Maps a raw (unknown) object to a K8sEvent. Missing or malformed fields
 * fall back to safe defaults so the rest of the pipeline is unaffected.
 *
 * Completely malformed records are skipped by returning `null`.
 */
function mapToEvent(raw: unknown): K8sEvent | null {
  if (!isRecord(raw)) return null;

  const involvedRaw = raw['involvedObject'];
  if (!hasRequiredInvolvedObjectFields(involvedRaw)) {
    return null;
  }

  const involvedObject = {
    kind: getString(involvedRaw['kind']),
    name: getString(involvedRaw['name']),
    namespace: getOptionalString(involvedRaw['namespace']),
  };

  return {
    type: getString(raw['type']),
    reason: getString(raw['reason']),
    message: getString(raw['message']),
    involvedObject,
    firstTimestamp: getOptionalString(raw['firstTimestamp']),
    lastTimestamp: getOptionalString(raw['lastTimestamp']),
    count: getOptionalNumber(raw['count']),
  };
}

/**
 * Normalises a parsed JSON/YAML value into an array of raw event objects.
 *
 * Accepts:
 * - A plain array of event objects
 * - An EventList wrapper `{ kind: 'EventList', items: [...] }`
 * - A single Event object `{ kind: 'Event', ... }`
 */
function normaliseToArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!isRecord(parsed)) return [];

  const kind = parsed['kind'];

  if (typeof kind === 'string' && kind.endsWith('List')) {
    const items = parsed['items'];
    if (Array.isArray(items)) {
      return items;
    }
    return [];
  }

  // Single document — wrap in array
  return [parsed];
}

// ---------------------------------------------------------------------------
// parseEventsJson
// ---------------------------------------------------------------------------

/**
 * Parses a JSON string into an array of {@link K8sEvent} objects.
 *
 * Accepts two formats:
 * - A raw JSON array: `[{ "type": "Warning", ... }, ...]`
 * - An EventList wrapper: `{ "kind": "EventList", "items": [...] }`
 *
 * On any parse or validation error a warning is logged and an empty array
 * is returned.
 */
export function parseEventsJson(content: string): K8sEvent[] {
  if (!content.trim()) return [];

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.warn(
      `[event-parser] Failed to parse events JSON: ${(err as Error).message}`,
    );
    return [];
  }

  const items = normaliseToArray(parsed);
  const events: K8sEvent[] = [];

  for (const item of items) {
    const event = mapToEvent(item);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// parseEventsYaml
// ---------------------------------------------------------------------------

/**
 * Parses a YAML string into an array of {@link K8sEvent} objects.
 *
 * Accepts:
 * - A single Event document
 * - An EventList document: `kind: EventList` with `items:` array
 * - Multiple `---`-separated YAML documents containing either format
 *
 * Malformed YAML documents are skipped with a warning so that a single bad
 * document does not abort parsing of the remaining content.
 */
export function parseEventsYaml(content: string): K8sEvent[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const documents = trimmed.split(/^---\s*$/m);
  const events: K8sEvent[] = [];

  for (const rawDocument of documents) {
    const docText = rawDocument.trim();
    if (!docText) continue;

    let parsed: unknown;

    try {
      parsed = yaml.load(docText);
    } catch (err) {
      console.warn(
        `[event-parser] Failed to parse events YAML: ${(err as Error).message}`,
      );
      continue;
    }

    if (parsed === null || parsed === undefined) continue;

    const items = normaliseToArray(parsed);

    for (const item of items) {
      const event = mapToEvent(item);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// parseEventFile
// ---------------------------------------------------------------------------

/**
 * Reads a Kubernetes events file from disk and parses it into
 * {@link K8sEvent}[].
 *
 * The parser is selected by file extension:
 * - `.json` → {@link parseEventsJson}
 * - everything else → {@link parseEventsYaml}
 *
 * On I/O or parse errors a warning is logged and an empty array is returned
 * so that the pipeline can continue processing other files.
 */
export async function parseEventFile(filePath: string): Promise<K8sEvent[]> {
  let content: string;

  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(
      `[event-parser] Could not read events file "${filePath}": ${(err as Error).message}`,
    );
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    return parseEventsJson(content);
  }

  return parseEventsYaml(content);
}
