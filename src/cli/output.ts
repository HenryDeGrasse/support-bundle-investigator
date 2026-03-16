import * as fsp from 'fs/promises';
import * as path from 'path';
import type { BundleProfile } from '../types/index.js';
import type { InvestigationTrace } from '../pipeline/trace.js';
import type { PipelineResult } from '../pipeline/analyze.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputOptions {
  format: 'json' | 'text' | 'summary';
  outputDir?: string;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

/**
 * Prints a human-readable summary of the bundle profile to stdout.
 */
export function printProfileSummary(profile: BundleProfile): void {
  const { manifest, analyzerCount, logFileCount, resourceCount, eventCount } = profile;

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Support Bundle Profile');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Bundle:       ${manifest.bundlePath}`);
  console.log(`  Files:        ${manifest.files.length}`);
  console.log(`  Analyzers:    ${analyzerCount}`);
  console.log(`  Resources:    ${resourceCount}`);
  console.log(`  Events:       ${eventCount}`);
  console.log(`  Log files:    ${logFileCount}`);
  console.log('');

  if (profile.namespaces.length > 0) {
    console.log(`  Namespaces:   ${profile.namespaces.join(', ')}`);
  }

  if (profile.workloads.length > 0) {
    console.log('');
    console.log('  Workloads:');
    for (const wl of profile.workloads) {
      console.log(`    - [${wl.kind}] ${wl.namespace}/${wl.name}`);
    }
  }

  if (profile.coverageGaps.length > 0) {
    console.log('');
    console.log('  Coverage gaps:');
    for (const gap of profile.coverageGaps) {
      console.log(`    ⚠  ${gap}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Prints a text summary of analysis results to stdout.
 */
export function printTextSummary(result: PipelineResult): void {
  printProfileSummary(result.profile);

  const errors = result.analyzerResults.filter((r) => r.isFail);
  const warns = result.analyzerResults.filter((r) => r.isWarn);

  if (errors.length > 0) {
    console.log('  ❌  Analyzer Errors:');
    for (const e of errors) {
      console.log(`    [${e.name}] ${e.title}`);
      if (e.message) console.log(`      ${e.message}`);
    }
    console.log('');
  }

  if (warns.length > 0) {
    console.log('  ⚠   Analyzer Warnings:');
    for (const w of warns) {
      console.log(`    [${w.name}] ${w.title}`);
      if (w.message) console.log(`      ${w.message}`);
    }
    console.log('');
  }

  const crashLoopPods = result.resources.filter(
    (r) =>
      r.kind === 'Pod' &&
      JSON.stringify(r.status).includes('CrashLoopBackOff'),
  );

  const imagePullPods = result.resources.filter(
    (r) =>
      r.kind === 'Pod' &&
      JSON.stringify(r.status).includes('ImagePullBackOff'),
  );

  if (crashLoopPods.length > 0) {
    console.log('  🔄  CrashLoopBackOff Pods:');
    for (const p of crashLoopPods) {
      console.log(
        `    - ${p.metadata.namespace ?? '_'}/${p.metadata.name}`,
      );
    }
    console.log('');
  }

  if (imagePullPods.length > 0) {
    console.log('  🚫  ImagePullBackOff Pods:');
    for (const p of imagePullPods) {
      console.log(
        `    - ${p.metadata.namespace ?? '_'}/${p.metadata.name}`,
      );
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

/**
 * Writes the investigation trace to a JSON file in `outputDir`.
 */
export async function writeTraceFile(
  trace: InvestigationTrace,
  outputDir: string,
): Promise<void> {
  await fsp.mkdir(outputDir, { recursive: true });
  const traceFile = path.join(outputDir, 'trace.json');
  await fsp.writeFile(traceFile, JSON.stringify(trace, null, 2), 'utf-8');
}

/**
 * Writes the pipeline result to disk or prints to stdout depending on the
 * output options.
 */
export async function writePipelineResult(
  result: PipelineResult,
  options: OutputOptions,
): Promise<void> {
  const { format, outputDir } = options;

  if (format === 'json') {
    const output = {
      profile: result.profile,
      analyzerResults: result.analyzerResults,
      resourceCount: result.resources.length,
      eventCount: result.events.length,
      logCount: result.logs.length,
      graphNodeCount: result.graph.nodes.size,
      trace: result.trace,
    };

    if (outputDir) {
      await fsp.mkdir(outputDir, { recursive: true });
      const outFile = path.join(outputDir, 'result.json');
      await fsp.writeFile(outFile, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`Results written to ${outFile}`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } else if (format === 'text') {
    printTextSummary(result);
  } else if (format === 'summary') {
    printProfileSummary(result.profile);
  }
}
