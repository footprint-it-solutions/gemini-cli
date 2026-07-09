/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig, normalizePath } from './test-helper.js';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('Pre-Commit Hook Checks', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should block agent turn on pre-commit check failure and trigger remediation', async () => {
    // 1. Basic rig setup
    await rig.setup(
      'should block agent turn on pre-commit check failure and trigger remediation',
      {
        fakeResponsesPath: join(
          import.meta.dirname,
          'pre-commit-hook.responses',
        ),
      },
    );

    const testDir = rig.testDir!;

    // 2. Initialize an isolated git repository in testDir
    execSync('git init', { cwd: testDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', {
      cwd: testDir,
      stdio: 'ignore',
    });
    execSync('git config user.email "test@example.com"', {
      cwd: testDir,
      stdio: 'ignore',
    });

    // Create a dummy file and commit it so we have a valid initial commit/HEAD
    writeFileSync(join(testDir, 'dummy.txt'), 'Initial file');
    execSync('git add dummy.txt', { cwd: testDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', {
      cwd: testDir,
      stdio: 'ignore',
    });

    // 3. Set up a mock package.json and pre-commit-trigger.js in testDir
    const mockPackageJson = {
      name: 'test-repo',
      private: true,
      type: 'module',
      scripts: {
        'pre-commit': 'node pre-commit-trigger.js',
      },
    };
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(mockPackageJson, null, 2),
    );

    const triggerScript = `
    import fs from 'node:fs';
    if (fs.existsSync('error.txt')) {
      fs.unlinkSync('error.txt'); // Delete so the second attempt passes
      console.error('Triggered fake pre-commit failure!');
      process.exit(1);
    }
    process.exit(0);
    `;
    writeFileSync(join(testDir, 'pre-commit-trigger.js'), triggerScript);

    // 4. Copy the hook script under test into testDir
    const hookSourcePath = join(
      import.meta.dirname,
      '../.gemini/hooks/pre-commit-check.js',
    );
    const hookContent = readFileSync(hookSourcePath, 'utf-8');

    mkdirSync(join(testDir, '.gemini/hooks'), { recursive: true });
    const hookDestPath = join(testDir, '.gemini/hooks/pre-commit-check.js');
    writeFileSync(hookDestPath, hookContent);

    // 5. Create error.txt to trigger the failure on the first turn
    writeFileSync(join(testDir, 'error.txt'), 'Introduce failure');

    // 6. Configure settings to enable and register our pre-commit hook
    await rig.setup(
      'should block agent turn on pre-commit check failure and trigger remediation',
      {
        settings: {
          hooksConfig: {
            enabled: true,
          },
          hooks: {
            AfterAgent: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: `node "${normalizePath(hookDestPath)}"`,
                    timeout: 10000,
                  },
                ],
              },
            ],
          },
        },
      },
    );

    // 7. Run the agent turn
    const result = await rig.run({ args: 'Create some files' });

    // 8. Assertions
    // We expect the first turn to fail pre-commit and trigger remediation
    expect(result).toContain('Git pre-commit checks failed');

    // Since remediation was triggered, the second turn was run, and since the script deleted error.txt,
    // the second pre-commit check passed, letting the agent complete its journey!
    expect(result).toContain('I have resolved the pre-commit failures');

    // Verify the hook logs and telemetry were recorded
    const hookTelemetryFound = await rig.waitForTelemetryEvent('hook_call');
    expect(hookTelemetryFound).toBeTruthy();

    const hookLogs = rig.readHookLogs();
    const afterAgentLogs = hookLogs.filter(
      (log) => log.hookCall.hook_event_name === 'AfterAgent',
    );

    expect(afterAgentLogs.length).toBeGreaterThanOrEqual(1);
    // The first execution should show decision "block" and contain the pre-commit trigger output
    const firstLog = afterAgentLogs[0];
    expect(firstLog.hookCall.stdout).toContain('"decision":"block"');
    expect(firstLog.hookCall.stdout).toContain(
      'Triggered fake pre-commit failure!',
    );
  });
});
