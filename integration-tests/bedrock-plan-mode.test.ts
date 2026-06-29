/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestRig } from './test-helper.js';

describe('Bedrock Plan Mode', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
    vi.stubEnv('AWS_CONFIG_FILE', '/home/andrew/repos/footprint-it-solutions/project-aerith/gemini-cli-custom/.aws/config');
    vi.stubEnv('AWS_PROFILE', 'Aerith-Development');
    vi.stubEnv('AWS_SDK_LOAD_CONFIG', '1');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rig.cleanup();
  });

  it('should successfully create a plan using Bedrock', async () => {
    const plansDir = '.gemini/tmp/bedrock-plan-tests/plans';
    const testName = 'should successfully create a plan using Bedrock';

    await rig.setup(testName, {
      settings: {
        model: {
          name: 'bedrock/eu.amazon.nova-2-lite-v1:0',
        },
        tools: {
          core: ['write_file', 'read_file', 'replace', 'update_topic', 'list_directory'],
        },
        general: {
          plan: { enabled: true, directory: plansDir },
          defaultApprovalMode: 'plan',
        },
      },
    });

    // Seed a file in the workspace
    const filePath = join(rig.testDir!, 'bedrock-test.txt');
    writeFileSync(filePath, 'Initial Content');

    console.log('Running test rig with Bedrock Plan Mode...');
    // Run the CLI in plan mode
    try {
      await rig.run({
        approvalMode: 'plan',
        args: 'Please create a plan using a relative path (write to "plan.md" directly relative to the plans directory) to change bedrock-test.txt content. Do not ask for confirmation and use only relative paths.',
      });
    } catch (err) {
      const toolLogs = rig.readToolLogs();
      console.error('ALL TOOL LOGS ON FAILURE:', JSON.stringify(toolLogs, null, 2));
      throw err;
    }

    // Check that write_file was successfully called to create the plan
    const toolLogs = rig.readToolLogs();
    
    console.log('ALL TOOL LOG DETAILS:', JSON.stringify(toolLogs, null, 2));

    const writePlanLog = toolLogs.find(
      (l) => l.toolRequest.name === 'write_file' && l.toolRequest.args.includes('plans') && l.toolRequest.success === true
    );

    expect(writePlanLog, 'Expected a successful write_file tool call in the plans directory').toBeDefined();
  }, 60000);

  it('should exhaustively plan and execute a multi-step Go code refactor', async () => {
    const plansDir = '.gemini/tmp/bedrock-plan-tests/plans';
    const testName = 'should exhaustively plan and execute a multi-step Go code refactor';

    await rig.setup(testName, {
      settings: {
        model: {
          name: 'bedrock/eu.amazon.nova-2-lite-v1:0',
        },
        tools: {
          core: ['write_file', 'read_file', 'replace', 'update_topic', 'list_directory', 'exit_plan_mode'],
        },
        general: {
          plan: { enabled: true, directory: plansDir },
          defaultApprovalMode: 'plan',
        },
      },
    });

    // Seed a realistic Go file
    const initialGoCode = `package main

import "fmt"

func main() {
    res := Calculate(10, 5)
    fmt.Println("Result:", res)
}

func Calculate(a, b int) int {
    // Basic addition
    return a + b
}
`;
    rig.createFile('math.go', initialGoCode);

    console.log('Running exhaustive Bedrock Go refactor test...');
    try {
      await rig.run({
        approvalMode: 'plan',
        args: 'First, read "math.go" to understand the calculate function. Second, write an implementation plan to "refactor.md" (stored directly in the plans directory) describing how we will add a Subtract(a, b int) function and call it in main. Third, transition to auto-edit mode using the exit_plan_mode tool. Fourth, actually modify "math.go" using the replace tool to add Subtract and update main.',
      });
    } catch (err) {
      const toolLogs = rig.readToolLogs();
      console.error('ALL TOOL LOGS ON FAILURE:', JSON.stringify(toolLogs, null, 2));
      throw err;
    }

    const toolLogs = rig.readToolLogs();
    console.log('ALL TOOL LOG DETAILS:', JSON.stringify(toolLogs, null, 2));

    // Assert that the plan was drafted
    const writePlanLog = toolLogs.find(
      (l) => l.toolRequest.name === 'write_file' && l.toolRequest.args.includes('plans') && l.toolRequest.success === true
    );
    expect(writePlanLog, 'Expected a successful write_file tool call for the plan').toBeDefined();

    // Assert that exit_plan_mode was executed
    const exitPlanLog = toolLogs.find(
      (l) => l.toolRequest.name === 'exit_plan_mode' && l.toolRequest.success === true
    );
    expect(exitPlanLog, 'Expected a successful exit_plan_mode tool call').toBeDefined();

    // Assert that replace was executed on the Go file
    const replaceLog = toolLogs.find(
      (l) => l.toolRequest.name === 'replace' && l.toolRequest.args.includes('math.go') && l.toolRequest.success === true
    );
    expect(replaceLog, 'Expected a successful replace tool call modifying math.go').toBeDefined();
  }, 120000);

  it('should interactively plan and execute a Go refactor under Bedrock', async () => {
    const plansDir = '.gemini/tmp/bedrock-plan-tests/plans';
    const testName = 'should interactively plan and execute a Go refactor under Bedrock';

    await rig.setup(testName, {
      settings: {
        model: {
          name: 'bedrock/eu.amazon.nova-2-lite-v1:0',
        },
        security: {
          auth: {
            selectedType: 'bedrock',
          },
        },
        tools: {
          core: ['write_file', 'read_file', 'replace', 'update_topic', 'list_directory', 'exit_plan_mode'],
        },
        general: {
          plan: { enabled: true, directory: plansDir },
          defaultApprovalMode: 'plan',
        },
      },
    });

    // Seed a Go file
    const initialGoCode = `package main

import "fmt"

func main() {
    res := Calculate(10, 5)
    fmt.Println("Result:", res)
}

func Calculate(a, b int) int {
    return a + b
}
`;
    rig.createFile('math.go', initialGoCode);

    console.log('Running interactive Bedrock Go refactor test...');
    const run = await rig.runInteractive({ approvalMode: 'plan' });

    try {
      // Send a concise initial prompt (must fit on a single line to avoid PTY wrapping check failures)
      await run.type('Plan and add Subtract to math.go');
      await run.type('\r');

      // 1. Wait for the Plan Mode approval dialog box to appear
      console.log('Waiting for plan approval dialogue...');
      await run.expectText('ready to start implementation?', 60000);

      // 2. Press Enter to select the default option: "yes, automatically accept edits"
      console.log('Accepting plan to start autonomous implementation...');
      await run.type('\r');

      // 3. Wait for the final autonomous replace and subsequent final model response to complete
      console.log('Waiting for autonomous replace and final model response...');
      await run.expectText('Accepted', 60000); // The CLI will print 'Accepted' once the replace tool executes successfully

      // Kill the persistent interactive CLI REPL session since we are done
      console.log('Terminating interactive CLI...');
      run.kill();

      // Directly read and assert on the modified Go file content on disk!
      const finalGoPath = join(rig.testDir!, 'math.go');
      const finalGoCode = require('node:fs').readFileSync(finalGoPath, 'utf8');
      console.log('FINAL GO CODE ON DISK:\n', finalGoCode);
      expect(finalGoCode).toContain('func Subtract(');
      expect(finalGoCode).toContain('Subtract(');
    } catch (e) {
      console.log('RAW INTERACTIVE PTY OUTPUT ON FAILURE:\n', run.output);
      run.kill();
      throw e;
    }
  }, 180000);
});
