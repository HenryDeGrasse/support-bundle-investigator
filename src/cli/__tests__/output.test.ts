import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeProvenanceFile } from '../output.js';
import type { Finding } from '../../types/index.js';

function makeFinding(): Finding {
  return {
    id: 'finding:ai:0',
    title: 'Image pull failure',
    severity: 'high',
    confidence: 0.85,
    affectedComponents: ['Pod/default/api'],
    reasoningSummary: 'The image tag does not exist.',
    evidence: [
      {
        path: 'cluster-resources/pods/default/api.yaml',
        note: 'ErrImagePull',
      },
    ],
    contradictionsChecked: [],
    recommendedAction: 'Fix the image tag.',
    missingEvidence: [],
    provenance: {
      investigator: 'ai',
      seedId: 'seed:merged:1',
      seedSource: 'analyzer:image',
      generatedAt: '2026-03-21T00:00:00.000Z',
      mergedFrom: ['finding:k8s:imagepull:0'],
      confidenceDelta: 0.2,
    },
  };
}

describe('writeProvenanceFile', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes provenance.json with one entry per finding', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-provenance-'));
    createdDirs.push(outputDir);

    await writeProvenanceFile([makeFinding()], outputDir);

    const written = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'provenance.json'), 'utf-8'),
    ) as Array<Record<string, unknown>>;

    expect(written).toEqual([
      {
        findingId: 'finding:ai:0',
        title: 'Image pull failure',
        provenance: {
          investigator: 'ai',
          seedId: 'seed:merged:1',
          seedSource: 'analyzer:image',
          generatedAt: '2026-03-21T00:00:00.000Z',
          mergedFrom: ['finding:k8s:imagepull:0'],
          confidenceDelta: 0.2,
        },
      },
    ]);
  });

  it('preserves findings without provenance as null entries', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-provenance-'));
    createdDirs.push(outputDir);

    await writeProvenanceFile([{ ...makeFinding(), id: 'finding:k8s:1', provenance: undefined }], outputDir);

    const written = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'provenance.json'), 'utf-8'),
    ) as Array<Record<string, unknown>>;

    expect(written[0]).toEqual({
      findingId: 'finding:k8s:1',
      title: 'Image pull failure',
      provenance: null,
    });
  });
});
