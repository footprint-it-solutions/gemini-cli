/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  consumeStartupBuildManifestResult,
  STARTUP_BUILD_MANIFEST_FILENAME,
  STARTUP_BUILD_MANIFEST_RESULT_ENV,
  verifyStartupBuildManifest,
} from './startupBuildVerification.js';

describe('startupBuildVerification', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    delete process.env[STARTUP_BUILD_MANIFEST_RESULT_ENV];
  });

  function createBundleFixture() {
    const bundleDir = mkdtempSync(join(tmpdir(), 'gemini-startup-build-'));
    tempDirs.push(bundleDir);
    writeFileSync(join(bundleDir, 'gemini.js'), 'console.log("gemini");\n');
    writeFileSync(join(bundleDir, 'chunk-1.js'), 'export const value = 1;\n');
    mkdirSync(join(bundleDir, 'docs'), { recursive: true });
    writeFileSync(join(bundleDir, 'docs', 'guide.md'), '# guide\n');

    const hash = (path: string) =>
      createHash('sha256')
        .update(readFileSync(join(bundleDir, path)))
        .digest('hex');

    writeFileSync(
      join(bundleDir, STARTUP_BUILD_MANIFEST_FILENAME),
      JSON.stringify(
        {
          schemaVersion: 1,
          buildId: 'build-1',
          version: '1.0.0',
          gitSha: 'abc1234',
          builtAt: '2026-07-02T12:00:00.000Z',
          entrypoint: 'gemini.js',
          files: ['chunk-1.js', 'docs/guide.md', 'gemini.js'].map((path) => ({
            path,
            sha256: hash(path),
            size: readFileSync(join(bundleDir, path)).length,
          })),
        },
        null,
        2,
      ) + '\n',
    );

    return bundleDir;
  }

  it('passes when the bundle matches the manifest', () => {
    const bundleDir = createBundleFixture();

    const result = verifyStartupBuildManifest(
      pathToFileURL(join(bundleDir, 'gemini.js')).href,
      {},
    );

    expect(result.status).toBe('passed');
    expect(result.fileCount).toBe(3);
    expect(result.missingFiles).toEqual([]);
    expect(result.mismatchedFiles).toEqual([]);
    expect(result.unexpectedFiles).toEqual([]);
  });

  it('fails when a manifest-listed file is missing', () => {
    const bundleDir = createBundleFixture();
    unlinkSync(join(bundleDir, 'chunk-1.js'));

    const result = verifyStartupBuildManifest(
      pathToFileURL(join(bundleDir, 'gemini.js')).href,
      {},
    );

    expect(result.status).toBe('failed');
    expect(result.missingFiles).toEqual(['chunk-1.js']);
    expect(result.mismatchedFiles).toEqual([
      {
        path: 'chunk-1.js',
        expectedSha256: expect.any(String),
        actualSha256: null,
      },
    ]);
  });

  it('fails when the bundle contains unexpected files', () => {
    const bundleDir = createBundleFixture();
    writeFileSync(join(bundleDir, 'stale-chunk.js'), 'stale\n');

    const result = verifyStartupBuildManifest(
      pathToFileURL(join(bundleDir, 'gemini.js')).href,
      {},
    );

    expect(result.status).toBe('failed');
    expect(result.unexpectedFiles).toEqual(['stale-chunk.js']);
  });

  it('consumes the serialized result from the environment', () => {
    process.env[STARTUP_BUILD_MANIFEST_RESULT_ENV] = JSON.stringify({
      status: 'passed',
      mode: 'warn',
      entryModulePath: '/tmp/gemini.js',
      bundleRoot: '/tmp',
      packageRoot: '/',
      manifestPath: '/tmp/build-manifest.json',
      fileCount: 1,
      missingFiles: [],
      mismatchedFiles: [],
      unexpectedFiles: [],
    });

    const result = consumeStartupBuildManifestResult(process.env);

    expect(result?.status).toBe('passed');
    expect(process.env[STARTUP_BUILD_MANIFEST_RESULT_ENV]).toBeUndefined();
  });
});
