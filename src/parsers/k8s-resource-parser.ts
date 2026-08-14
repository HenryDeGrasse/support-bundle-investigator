import * as fsp from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { K8sResource } from '../types/index.js';
import { isK8sResource } from '../utils/type-guards.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns true only for resources with a safe, usable object identity. */
function isValidResource(doc: unknown): doc is K8sResource {
  return (
    isK8sResource(doc) &&
    doc.apiVersion.trim().length > 0 &&
    doc.kind.trim().length > 0 &&
    doc.metadata.name.trim().length > 0
  );
}

interface K8sListEnvelope {
  apiVersion: string;
  kind: string;
  items: unknown[];
}

/**
 * Kubernetes List envelopes do not have an object identity and commonly omit
 * `metadata.name`. They are safe as containers as long as their own required
 * fields and items array are well-shaped; every returned item is still passed
 * through the strict resource validator above.
 */
function isValidListEnvelope(doc: unknown): doc is K8sListEnvelope {
  return (
    isRecord(doc) &&
    typeof doc['apiVersion'] === 'string' &&
    doc['apiVersion'].trim().length > 0 &&
    typeof doc['kind'] === 'string' &&
    doc['kind'].trim().length > 0 &&
    doc['kind'].endsWith('List') &&
    Array.isArray(doc['items']) &&
    (doc['metadata'] === undefined || isRecord(doc['metadata']))
  );
}

// ---------------------------------------------------------------------------
// List unwrapping
// ---------------------------------------------------------------------------

/**
 * If the resource is a *List kind (e.g. PodList, DeploymentList) that
 * contains an `items` array, returns the individual items.  Otherwise
 * returns a single-element array containing the resource itself.
 */
function expandListResource(resource: K8sResource | K8sListEnvelope): K8sResource[] {
  if (!resource.kind.endsWith('List')) {
    return [resource as K8sResource];
  }

  const items = (resource as unknown as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items.filter(isValidResource) : [];
}

// ---------------------------------------------------------------------------
// parseResourceYaml
// ---------------------------------------------------------------------------

/**
 * Parses a YAML string (possibly containing multiple `---`-separated
 * documents) and returns all valid K8sResource objects found.
 *
 * Malformed documents are skipped with a warning so that a single bad
 * document does not abort the parse of the remaining content.
 */
export function parseResourceYaml(content: string): K8sResource[] {
  const results: K8sResource[] = [];

  // Split on YAML document separators so each document can be tried
  // independently — this way a single malformed document doesn't abort
  // the entire file.
  const rawDocuments = content.split(/^---\s*$/m);

  for (const rawDoc of rawDocuments) {
    const trimmed = rawDoc.trim();
    if (!trimmed) continue;

    let doc: unknown;

    try {
      doc = yaml.load(trimmed);
    } catch (err) {
      console.warn(
        `[k8s-resource-parser] Skipping malformed YAML document: ${(err as Error).message}`,
      );
      continue;
    }

    if (doc === null || doc === undefined) continue;

    if (!isValidResource(doc) && !isValidListEnvelope(doc)) {
      console.warn(
        '[k8s-resource-parser] Skipping document — invalid apiVersion, kind, or metadata shape/name',
      );
      continue;
    }

    results.push(...expandListResource(doc));
  }

  return results;
}

// ---------------------------------------------------------------------------
// parseResourceJson
// ---------------------------------------------------------------------------

/**
 * Parses a JSON string that represents a single K8sResource (or a *List
 * kind whose `items` are unwrapped) and returns a K8sResource[].
 *
 * On parse or validation failure a warning is logged and an empty array
 * is returned.
 */
export function parseResourceJson(content: string): K8sResource[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.warn(
      `[k8s-resource-parser] Failed to parse resource JSON: ${(err as Error).message}`,
    );
    return [];
  }

  if (!isValidResource(parsed) && !isValidListEnvelope(parsed)) {
    console.warn(
      '[k8s-resource-parser] JSON does not represent a valid K8sResource — invalid apiVersion, kind, or metadata shape/name',
    );
    return [];
  }

  return expandListResource(parsed);
}

// ---------------------------------------------------------------------------
// parseResourceFile
// ---------------------------------------------------------------------------

/**
 * Reads a Kubernetes resource file from disk and parses it.
 *
 * The parser is selected based on the file extension:
 * - `.json` → {@link parseResourceJson}
 * - everything else (`.yaml`, `.yml`, unknown) → {@link parseResourceYaml}
 *
 * On I/O or parse errors a warning is logged and an empty array is returned
 * so that the pipeline can continue processing other files.
 */
export async function parseResourceFile(filePath: string): Promise<K8sResource[]> {
  let content: string;

  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(
      `[k8s-resource-parser] Could not read resource file "${filePath}": ${(err as Error).message}`,
    );
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    return parseResourceJson(content);
  }

  return parseResourceYaml(content);
}
