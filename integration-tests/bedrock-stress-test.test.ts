/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestRig } from './test-helper.js';

function generateLargeGoFile(index: number): string {
  let content = `package main

import "fmt"

// File math_${index}.go
// This is a 500+ line complex Go file to stress-test Bedrock.

func Run_File_${index}() {
    fmt.Println("Running file ${index}...")
    res := Calculate_${index}(100, 50)
    fmt.Println("Calculation Result:", res)
}

func Calculate_${index}(a, b int) int {
    return a + b
}
`;

  // Append 65 calculation functions to guarantee > 500 lines of code
  for (let i = 1; i <= 65; i++) {
    content += `
// Complex math operation block ${i}
func Math_Op_${index}_${i}(a, b int) int {
    if a > b {
        return (a * b) + ${i} - a
    }
    if a < b {
        return (b / a) * ${i} + b
    }
    return a + b + ${i}
}
`;
  }

  return content;
}

describe('Bedrock Massive Go Stress Test', () => {
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

  it('should exhaustively plan and execute refactorings across 20 Go files of 500+ lines each', async () => {
    const plansDir = '.gemini/tmp/bedrock-stress-tests/plans';
    const testName = 'should exhaustively plan and execute refactorings across 20 Go files of 500+ lines each';

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

    // Programmatically seed 20 complex Go files (each 500+ lines)
    console.log('Generating 20 large Go files (each 500+ lines, total ~10,700 lines of code)...');
    for (let i = 0; i < 20; i++) {
      const goCode = generateLargeGoFile(i);
      rig.createFile(`math_${i}.go`, goCode);
    }
    rig.sync();

    console.log('Invoking Bedrock for massive Go codebase stress refactor...');
    try {
      await rig.run({
        approvalMode: 'plan',
        args: 'Perform the following complex codebase-wide refactoring steps: First, read the first file "math_0.go" and the last file "math_19.go" to verify their content. Second, write a brief implementation plan to "stress_plan.md" (stored directly in the plans directory) describing how we will modify function Math_Op_0_1 inside "math_0.go" (change its return calculation multiplier), and modify function Math_Op_19_65 inside "math_19.go" (change its subtractor). Third, transition out of plan mode using the exit_plan_mode tool. Fourth, execute both of those edits exactly as planned using the replace tool on "math_0.go" and "math_19.go".',
      });
    } catch (err) {
      const toolLogs = rig.readToolLogs();
      console.error('STRESS TEST ALL TOOL LOGS ON FAILURE:', JSON.stringify(toolLogs, null, 2));
      throw err;
    }

    const toolLogs = rig.readToolLogs();
    console.log('STRESS TEST TOOL LOG DETAILS:', JSON.stringify(toolLogs, null, 2));

    // Assert plan was written
    const writePlanLog = toolLogs.find(
      (l) => l.toolRequest.name === 'write_file' && l.toolRequest.args.includes('stress_plan.md') && l.toolRequest.success === true
    );
    expect(writePlanLog, 'Expected a successful write_file tool call for the stress plan').toBeDefined();

    // Assert exit_plan_mode was executed
    const exitPlanLog = toolLogs.find(
      (l) => l.toolRequest.name === 'exit_plan_mode' && l.toolRequest.success === true
    );
    expect(exitPlanLog, 'Expected a successful exit_plan_mode tool call').toBeDefined();

    // Assert replace was executed on math_0.go
    const replaceLog0 = toolLogs.find(
      (l) => l.toolRequest.name === 'replace' && l.toolRequest.args.includes('math_0.go') && l.toolRequest.success === true
    );
    expect(replaceLog0, 'Expected a successful replace tool call modifying math_0.go').toBeDefined();

    // Assert replace was executed on math_19.go
    const replaceLog19 = toolLogs.find(
      (l) => l.toolRequest.name === 'replace' && l.toolRequest.args.includes('math_19.go') && l.toolRequest.success === true
    );
    expect(replaceLog19, 'Expected a successful replace tool call modifying math_19.go').toBeDefined();

    // Verify disk content
    const file0Content = readFileSync(join(rig.testDir!, 'math_0.go'), 'utf8');
    const file19Content = readFileSync(join(rig.testDir!, 'math_19.go'), 'utf8');

    expect(file0Content).not.toContain('return (a * b) + 1 - a');
    expect(file19Content).not.toContain('return a + b + 65');
  }, 300000); // 5-minute timeout for heavy stress-testing
});
