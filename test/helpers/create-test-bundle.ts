import * as fs from "fs/promises";
import * as path from "path";
import * as tar from "tar";

/**
 * Returns the absolute path to the fixture directory for a given scenario name.
 */
export function getFixturePath(scenario: string): string {
  return path.resolve(__dirname, "../fixtures/scenarios", scenario);
}

/**
 * Packs a scenario directory into a .tar.gz bundle archive.
 *
 * @param scenarioDir - Absolute or relative path to the directory to pack.
 * @param outputPath  - Absolute or relative path for the output .tar.gz file.
 * @returns The resolved output path.
 */
export async function createTestBundle(
  scenarioDir: string,
  outputPath: string
): Promise<string> {
  const absoluteScenarioDir = path.resolve(scenarioDir);
  const absoluteOutputPath = path.resolve(outputPath);

  const scenarioStats = await fs.stat(absoluteScenarioDir).catch(() => null);
  if (!scenarioStats?.isDirectory()) {
    throw new Error(`Scenario directory does not exist: ${absoluteScenarioDir}`);
  }

  await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  // Collect entries relative to the parent of scenarioDir so that the
  // archive contains the scenario folder itself at its root.
  const parentDir = path.dirname(absoluteScenarioDir);
  const scenarioName = path.basename(absoluteScenarioDir);

  await tar.c(
    {
      gzip: true,
      file: absoluteOutputPath,
      cwd: parentDir,
    },
    [scenarioName]
  );

  return absoluteOutputPath;
}
