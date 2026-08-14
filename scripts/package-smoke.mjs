#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbi-pack-smoke-'));
const packDir = path.join(temporaryRoot, 'pack');
const consumerDir = path.join(temporaryRoot, 'consumer');
const projectPackage = JSON.parse(
  await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const expectedVersion = projectPackage.version;
assert.equal(typeof expectedVersion, 'string', 'package.json must define a version');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }

  return result.stdout.trim();
}

function binPath(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(consumerDir, 'node_modules', '.bin', `${name}${suffix}`);
}

try {
  await fsp.mkdir(packDir, { recursive: true });
  await fsp.mkdir(consumerDir, { recursive: true });
  await fsp.writeFile(
    path.join(consumerDir, 'package.json'),
    '{"name":"sbi-package-smoke","private":true}\n',
    'utf8',
  );

  run('npm', ['pack', '--silent', '--pack-destination', packDir], projectRoot);
  const tarballs = (await fsp.readdir(packDir)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'npm pack must produce exactly one tarball');
  const tarballPath = path.join(packDir, tarballs[0]);

  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    consumerDir,
  );

  const installedRoot = path.join(
    consumerDir,
    'node_modules',
    'support-bundle-investigator',
  );
  const requiredFiles = [
    'dist/index.js',
    'dist/index.mjs',
    'dist/index.d.ts',
    'dist/cli/run.mjs',
    'dist/cli/rat.mjs',
    'dist/tui/index.js',
    'dist/tui/index.mjs',
    'package.json',
  ];
  for (const relativePath of requiredFiles) {
    assert.ok(
      fs.existsSync(path.join(installedRoot, relativePath)),
      `packed artifact is missing ${relativePath}`,
    );
  }
  for (const excludedPath of ['src', 'test', '.env']) {
    assert.ok(
      !fs.existsSync(path.join(installedRoot, excludedPath)),
      `packed artifact unexpectedly contains ${excludedPath}`,
    );
  }
  const installedPackage = JSON.parse(
    await fsp.readFile(path.join(installedRoot, 'package.json'), 'utf8'),
  );
  assert.equal(installedPackage.version, expectedVersion);

  const commonJsOutput = run(
    process.execPath,
    [
      '-e',
      "const pkg=require('support-bundle-investigator'); process.stdout.write(pkg.VERSION)",
    ],
    consumerDir,
  );
  assert.equal(commonJsOutput, expectedVersion);

  const esmOutput = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { VERSION } from 'support-bundle-investigator'; process.stdout.write(VERSION)",
    ],
    consumerDir,
  );
  assert.equal(esmOutput, expectedVersion);

  for (const binary of ['sbi', 'rat']) {
    const output = run(binPath(binary), ['--version'], consumerDir);
    assert.equal(
      output,
      expectedVersion,
      `${binary} --version must report the package version`,
    );
  }

  console.log(`Package smoke test passed: ${tarballs[0]}`);
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
