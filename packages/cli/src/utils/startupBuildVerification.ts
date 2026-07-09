/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STARTUP_BUILD_MANIFEST_FILENAME = 'build-manifest.json';
export const STARTUP_BUILD_MANIFEST_MODE_ENV =
  'GEMINI_CLI_STARTUP_BUILD_MANIFEST';
export const STARTUP_BUILD_MANIFEST_RESULT_ENV =
  'GEMINI_CLI_STARTUP_BUILD_MANIFEST_RESULT';
export const STARTUP_BUILD_MANIFEST_VERIFIED_ENV =
  'GEMINI_CLI_STARTUP_BUILD_MANIFEST_VERIFIED';
export const STARTUP_BUILD_MANIFEST_VERBOSE_ENV =
  'GEMINI_CLI_STARTUP_BUILD_MANIFEST_VERBOSE';

export type StartupBuildManifestMode = 'off' | 'warn' | 'strict';

interface StartupBuildManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface StartupBuildManifest {
  schemaVersion: 1;
  buildId: string;
  version: string;
  gitSha: string;
  builtAt: string;
  entrypoint: string;
  files: StartupBuildManifestFile[];
}

interface MismatchedFile {
  path: string;
  expectedSha256: string;
  actualSha256: string | null;
}

export interface StartupBuildVerificationResult {
  status: 'passed' | 'failed' | 'skipped';
  mode: StartupBuildManifestMode;
  reason?: string;
  buildId?: string;
  version?: string;
  gitSha?: string;
  builtAt?: string;
  entrypoint?: string;
  entryModulePath: string;
  invocationPath?: string;
  bundleRoot: string;
  packageRoot: string;
  manifestPath: string;
  fileCount: number;
  missingFiles: string[];
  mismatchedFiles: MismatchedFile[];
  unexpectedFiles: string[];
}

export interface StartupBuildVerificationExecution {
  result: StartupBuildVerificationResult;
  shouldExit: boolean;
}

function hasProperty<T extends string>(
  obj: object,
  prop: T,
): obj is { [key in T]: unknown } {
  return prop in obj;
}

function isStartupBuildManifest(obj: unknown): obj is StartupBuildManifest {
  if (typeof obj !== 'object' || obj === null) return false;
  return (
    hasProperty(obj, 'schemaVersion') &&
    typeof obj.schemaVersion === 'number' &&
    hasProperty(obj, 'buildId') &&
    typeof obj.buildId === 'string' &&
    hasProperty(obj, 'version') &&
    typeof obj.version === 'string' &&
    hasProperty(obj, 'gitSha') &&
    typeof obj.gitSha === 'string' &&
    hasProperty(obj, 'builtAt') &&
    typeof obj.builtAt === 'string' &&
    hasProperty(obj, 'entrypoint') &&
    typeof obj.entrypoint === 'string' &&
    hasProperty(obj, 'files') &&
    Array.isArray(obj.files)
  );
}

function isStartupBuildVerificationResult(
  obj: unknown,
): obj is StartupBuildVerificationResult {
  if (typeof obj !== 'object' || obj === null) return false;
  return (
    hasProperty(obj, 'status') &&
    (obj.status === 'passed' ||
      obj.status === 'failed' ||
      obj.status === 'skipped') &&
    hasProperty(obj, 'entryModulePath') &&
    typeof obj.entryModulePath === 'string' &&
    hasProperty(obj, 'bundleRoot') &&
    typeof obj.bundleRoot === 'string' &&
    hasProperty(obj, 'packageRoot') &&
    typeof obj.packageRoot === 'string' &&
    hasProperty(obj, 'manifestPath') &&
    typeof obj.manifestPath === 'string' &&
    hasProperty(obj, 'fileCount') &&
    typeof obj.fileCount === 'number' &&
    hasProperty(obj, 'missingFiles') &&
    Array.isArray(obj.missingFiles) &&
    hasProperty(obj, 'mismatchedFiles') &&
    Array.isArray(obj.mismatchedFiles) &&
    hasProperty(obj, 'unexpectedFiles') &&
    Array.isArray(obj.unexpectedFiles)
  );
}

function parseMode(value: string | undefined): StartupBuildManifestMode {
  switch ((value || '').toLowerCase()) {
    case 'off':
      return 'off';
    case 'strict':
      return 'strict';
    default:
      return 'warn';
  }
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function collectBundleFiles(
  rootDir: string,
  currentDir: string = rootDir,
): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectBundleFiles(rootDir, absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const relativePath = absolutePath
      .slice(rootDir.length + 1)
      .replaceAll('\\', '/');
    if (relativePath === STARTUP_BUILD_MANIFEST_FILENAME) {
      continue;
    }
    files.push(relativePath);
  }

  return files;
}

function emitLogLine(
  result: StartupBuildVerificationResult,
  env: NodeJS.ProcessEnv,
): void {
  const payload = JSON.stringify({
    event: 'startup-build-verification',
    ...result,
  });

  const debugLogFile = env['GEMINI_DEBUG_LOG_FILE'];
  if (debugLogFile) {
    try {
      const timestamp = new Date().toISOString();
      appendFileSync(
        debugLogFile,
        `[${timestamp}] [STARTUP] ${payload}\n`,
        'utf8',
      );
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(
          `[StartupBuildVerification] Failed to write debug log: ${error.message}\n`,
        );
      } else {
        process.stderr.write(
          `[StartupBuildVerification] Failed to write debug log: ${String(error)}\n`,
        );
      }
    }
  }

  const verbose = env[STARTUP_BUILD_MANIFEST_VERBOSE_ENV] === 'true';
  if (result.status === 'failed' || verbose) {
    const summary = [
      `[StartupBuildVerification] ${result.status.toUpperCase()}`,
      `mode=${result.mode}`,
      `buildId=${result.buildId ?? 'n/a'}`,
      `gitSha=${result.gitSha ?? 'n/a'}`,
      `bundleRoot=${result.bundleRoot}`,
      `manifest=${result.manifestPath}`,
      `reason=${result.reason ?? 'ok'}`,
      `missing=${result.missingFiles.length}`,
      `mismatched=${result.mismatchedFiles.length}`,
      `unexpected=${result.unexpectedFiles.length}`,
    ].join(' ');
    process.stderr.write(summary + '\n');
  }
}

export function verifyStartupBuildManifest(
  entryModuleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): StartupBuildVerificationResult {
  const mode = parseMode(env[STARTUP_BUILD_MANIFEST_MODE_ENV]);
  const entryModulePath = fileURLToPath(entryModuleUrl);
  const bundleRoot = dirname(entryModulePath);
  const packageRoot = dirname(bundleRoot);
  const manifestPath = join(bundleRoot, STARTUP_BUILD_MANIFEST_FILENAME);
  const invocationPath = process.argv[1];

  if (mode === 'off') {
    return {
      status: 'skipped',
      mode,
      reason: 'verification_disabled',
      entryModulePath,
      invocationPath,
      bundleRoot,
      packageRoot,
      manifestPath,
      fileCount: 0,
      missingFiles: [],
      mismatchedFiles: [],
      unexpectedFiles: [],
    };
  }

  if (!existsSync(manifestPath)) {
    return {
      status: 'skipped',
      mode,
      reason: 'manifest_not_found',
      entryModulePath,
      invocationPath,
      bundleRoot,
      packageRoot,
      manifestPath,
      fileCount: 0,
      missingFiles: [],
      mismatchedFiles: [],
      unexpectedFiles: [],
    };
  }

  try {
    const rawManifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as unknown;

    // Validate that the parsed object has the required properties
    if (!isStartupBuildManifest(rawManifest)) {
      return {
        status: 'failed',
        mode,
        reason: 'manifest_validation_error',
        entryModulePath,
        invocationPath,
        bundleRoot,
        packageRoot,
        manifestPath,
        fileCount: 0,
        missingFiles: [],
        mismatchedFiles: [],
        unexpectedFiles: [],
      };
    }

    // We already validated the manifest structure above, so we can safely use it as StartupBuildManifest
    const manifest = rawManifest;

    const expectedFiles = new Map(
      (manifest.files || []).map((file) => [file.path, file]),
    );
    const actualFiles = collectBundleFiles(bundleRoot);
    const missingFiles: string[] = [];
    const mismatchedFiles: MismatchedFile[] = [];

    for (const [relativePath, expectedFile] of expectedFiles) {
      const absolutePath = join(bundleRoot, relativePath);
      if (!existsSync(absolutePath)) {
        missingFiles.push(relativePath);
        mismatchedFiles.push({
          path: relativePath,
          expectedSha256: expectedFile.sha256,
          actualSha256: null,
        });
        continue;
      }

      const actualSize = statSync(absolutePath).size;
      const actualSha256 = hashFile(absolutePath);
      if (
        actualSize !== expectedFile.size ||
        actualSha256 !== expectedFile.sha256
      ) {
        mismatchedFiles.push({
          path: relativePath,
          expectedSha256: expectedFile.sha256,
          actualSha256: actualSha256 || null,
        });
      }
    }

    const unexpectedFiles = actualFiles.filter(
      (relativePath) => !expectedFiles.has(relativePath),
    );

    return {
      status:
        missingFiles.length > 0 ||
        mismatchedFiles.length > 0 ||
        unexpectedFiles.length > 0
          ? 'failed'
          : 'passed',
      mode,
      reason: 'manifest_loaded',
      buildId: manifest.buildId,
      version: manifest.version,
      gitSha: manifest.gitSha,
      builtAt: manifest.builtAt,
      entrypoint: manifest.entrypoint,
      entryModulePath,
      invocationPath,
      bundleRoot,
      packageRoot,
      manifestPath,
      fileCount: expectedFiles.size,
      missingFiles,
      mismatchedFiles,
      unexpectedFiles,
    };
  } catch (error) {
    return {
      status: 'failed',
      mode,
      reason:
        error instanceof Error
          ? `manifest_parse_error:${error.message}`
          : 'manifest_parse_error',
      entryModulePath,
      invocationPath,
      bundleRoot,
      packageRoot,
      manifestPath,
      fileCount: 0,
      missingFiles: [],
      mismatchedFiles: [],
      unexpectedFiles: [],
    };
  }
}

export function runStartupBuildManifestVerification(
  entryModuleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): StartupBuildVerificationExecution {
  const existingResult = env[STARTUP_BUILD_MANIFEST_RESULT_ENV];
  if (env[STARTUP_BUILD_MANIFEST_VERIFIED_ENV] === 'true' && existingResult) {
    try {
      const parsed = JSON.parse(existingResult) as unknown;
      if (isStartupBuildVerificationResult(parsed)) {
        return {
          result: parsed,
          shouldExit: false,
        };
      }
    } catch {
      return {
        result: {
          status: 'failed',
          mode: 'warn',
          reason: 'result_parse_error',
          entryModulePath: fileURLToPath(import.meta.url),
          invocationPath: process.argv[1],
          bundleRoot: dirname(fileURLToPath(import.meta.url)),
          packageRoot: dirname(dirname(fileURLToPath(import.meta.url))),
          manifestPath: join(
            dirname(fileURLToPath(import.meta.url)),
            STARTUP_BUILD_MANIFEST_FILENAME,
          ),
          fileCount: 0,
          missingFiles: [],
          mismatchedFiles: [],
          unexpectedFiles: [],
        },
        shouldExit: false,
      };
    }
  }

  const result = verifyStartupBuildManifest(entryModuleUrl, env);
  env[STARTUP_BUILD_MANIFEST_RESULT_ENV] = JSON.stringify(result);
  env[STARTUP_BUILD_MANIFEST_VERIFIED_ENV] = 'true';
  emitLogLine(result, env);

  return {
    result,
    shouldExit: result.status === 'failed' && result.mode === 'strict',
  };
}

export function consumeStartupBuildManifestResult(
  env: NodeJS.ProcessEnv = process.env,
): StartupBuildVerificationResult | null {
  const rawResult = env[STARTUP_BUILD_MANIFEST_RESULT_ENV];
  if (!rawResult) {
    return null;
  }

  delete env[STARTUP_BUILD_MANIFEST_RESULT_ENV];

  try {
    const parsed = JSON.parse(rawResult) as unknown;
    if (isStartupBuildVerificationResult(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    // Safely handle process.argv access
    const argv1 = process.argv[1] || process.execPath;
    return {
      status: 'failed',
      mode: 'warn',
      reason: 'manifest_result_parse_error',
      entryModulePath: fileURLToPath(pathToFileURL(argv1)),
      invocationPath: argv1,
      bundleRoot: dirname(argv1),
      packageRoot: dirname(dirname(argv1)),
      manifestPath: join(dirname(argv1), STARTUP_BUILD_MANIFEST_FILENAME),
      fileCount: 0,
      missingFiles: [],
      mismatchedFiles: [],
      unexpectedFiles: [],
    };
  }
}
