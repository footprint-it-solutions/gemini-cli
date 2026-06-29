/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';

describe('Bedrock Plan Mode', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
    process.env.AWS_CONFIG_FILE = '/Users/andrew/repos/footprint-it-solutions/project-aerith/gemini-cli-bedrock/.aws/config';
    process.env.AWS_PROFILE = 'Aerith-Development';
    process.env.AWS_SDK_LOAD_CONFIG = '1';
  });

  afterEach(async () => await rig.cleanup());

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
  });
});
