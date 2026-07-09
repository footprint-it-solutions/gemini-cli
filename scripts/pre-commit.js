/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';

try {
  // Get repository root
  const root = execSync('git rev-parse --show-toplevel').toString().trim();

  // Run lint-staged via CLI
  execSync('npx lint-staged', { cwd: root, stdio: 'inherit' });

  // If we get here, linting passed
  process.exit(0);
} catch (error) {
  // If linting fails, the execSync will throw an error
  console.error('Pre-commit hook failed:', error.message);
  process.exit(1);
}
