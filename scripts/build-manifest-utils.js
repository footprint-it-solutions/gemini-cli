/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_MANIFEST_FILENAME = 'build-manifest.json';

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function collectFiles(rootDir, currentDir = rootDir) {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(rootDir, absolutePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = absolutePath
      .slice(rootDir.length + 1)
      .replaceAll('\\', '/');
    if (relativePath === BUILD_MANIFEST_FILENAME) {
      continue;
    }

    files.push({
      path: relativePath,
      sha256: hashFile(absolutePath),
      size: statSync(absolutePath).size,
    });
  }

  return files;
}

export function createBundleBuildManifest({
  bundleDir,
  version,
  gitSha,
  builtAt,
  buildId,
  entrypoint = 'gemini.js',
}) {
  const files = collectFiles(bundleDir);
  return {
    schemaVersion: 1,
    buildId,
    version,
    gitSha,
    builtAt,
    entrypoint,
    files,
  };
}
