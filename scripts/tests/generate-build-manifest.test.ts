/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUILD_MANIFEST_FILENAME,
  createBundleBuildManifest,
} from '../build-manifest-utils.js';

describe('createBundleBuildManifest', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('hashes all bundle files except the manifest itself', () => {
    const bundleDir = mkdtempSync(join(tmpdir(), 'gemini-build-manifest-'));
    tempDirs.push(bundleDir);

    mkdirSync(join(bundleDir, 'docs'), { recursive: true });
    writeFileSync(join(bundleDir, 'gemini.js'), 'console.log("hi");\n');
    writeFileSync(join(bundleDir, 'chunk-abc.js'), 'export const x = 1;\n');
    writeFileSync(join(bundleDir, 'docs', 'guide.md'), '# guide\n');
    writeFileSync(join(bundleDir, BUILD_MANIFEST_FILENAME), '{}\n');

    const manifest = createBundleBuildManifest({
      bundleDir,
      version: '1.2.3',
      gitSha: 'abc1234',
      builtAt: '2026-07-02T12:00:00.000Z',
      buildId: 'test-build',
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: '1.2.3',
      gitSha: 'abc1234',
      buildId: 'test-build',
      entrypoint: 'gemini.js',
    });
    expect(manifest.files.map((file) => file.path)).toEqual([
      'chunk-abc.js',
      'docs/guide.md',
      'gemini.js',
    ]);
    expect(manifest.files.every((file) => file.sha256.length === 64)).toBe(
      true,
    );
  });
});
