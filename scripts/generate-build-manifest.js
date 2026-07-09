/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST_FILENAME,
  createBundleBuildManifest,
} from './build-manifest-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');
const manifestPath = join(bundleDir, BUILD_MANIFEST_FILENAME);

function getGitSha() {
  const envCommit = process.env.GIT_COMMIT;
  if (envCommit && /^[0-9a-f]+$/i.test(envCommit)) {
    return envCommit;
  }

  try {
    const gitHash = execSync('git rev-parse --short HEAD', {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    return gitHash || 'N/A';
  } catch {
    return 'N/A';
  }
}

if (!existsSync(bundleDir)) {
  console.error(`Bundle directory not found at ${bundleDir}`);
  process.exit(1);
}

const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
const builtAt = new Date().toISOString();
const gitSha = getGitSha();
const version = packageJson.version || '0.0.0';
const buildId = `${version}+${gitSha}+${builtAt.replace(/[:.]/g, '-')}`;

const manifest = createBundleBuildManifest({
  bundleDir,
  version,
  gitSha,
  builtAt,
  buildId,
});

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `Generated ${BUILD_MANIFEST_FILENAME} with ${manifest.files.length} file hashes for build ${buildId}`,
);
