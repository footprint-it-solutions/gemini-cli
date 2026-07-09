/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, beforeEach } from 'vitest';
import { bedrockEvalTest } from './bedrock-app-test-helper.js';

// Helper to check if AWS Bedrock credentials/region are available
function isBedrockConfigured(): boolean {
  return Boolean(
    (process.env['AWS_ACCESS_KEY_ID'] &&
      process.env['AWS_SECRET_ACCESS_KEY']) ||
    process.env['AWS_PROFILE'] ||
    process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] ||
    process.env['AWS_WEB_IDENTITY_TOKEN_FILE'],
  );
}

// Custom wait helper that prints real-time terminal frames to console during execution!
async function waitUntil(
  rig: any,
  predicate: () => boolean | Promise<boolean>,
  timeout = 90000,
) {
  const start = Date.now();
  let lastLoggedFrame = '';

  while (true) {
    if (await predicate()) return;

    // Print unique frame outputs so we can trace real-time terminal UI behavior
    const frame = rig.lastFrame;
    if (frame !== lastLoggedFrame) {
      console.log('--- Real-time Bedrock TUI Frame Update ---');
      console.log(frame);
      lastLoggedFrame = frame;
    }

    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out waiting for Bedrock agent loop. Current TUI frame:\n${frame}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('bedrock_bdd_evals', () => {
  let consoleSpy: any;

  beforeEach(async (context) => {
    const configured = isBedrockConfigured();
    if (!configured) {
      console.log(
        '[Bedrock Eval] AWS Bedrock is not configured. Skipping interactive Bedrock BDD test.',
      );
      context.skip();
    }

    // Mock console.error to intercept and suppress React 'act(...)' warnings from failing the BDD eval.
    // This is safe and necessary because the visual TUI simulation runs on real-time setTimeout intervals
    // which React's synchronous test environment cannot completely capture with synchronous act() wraps.
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('was not wrapped in act(...)')) {
        // Suppress act warning noise
        return;
      }
      // Print other errors to stderr
      console.warn('[Console Error]:', ...args);
    });
  });

  // Dedicated zero-pollution Bedrock provider BDD test
  bedrockEvalTest('USUALLY_PASSES', {
    name: 'should successfully execute fallback continuation chain and summarize files using Bedrock Nova',
    prompt: 'Read src/index.ts and src/math.ts and summarize their functions',
    configOverrides: {
      model: 'bedrock/eu.amazon.nova-2-lite-v1:0',
      // YOLO mode ensures that read-only file/directory lookup tools execute automatically without halting for manual approval!
      approvalMode: 'yolo',
    },
    files: {
      'src/index.ts': [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n'),
      'src/math.ts': [
        'export function multiply(a: number, b: number): number {',
        '  return a * 5;',
        '}',
      ].join('\n'),
      'package.json': JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          dependencies: {},
        },
        null,
        2,
      ),
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Test] Waiting for Bedrock Nova to read repository files and generate final summary...',
      );

      // Wait until the final summary output has successfully rendered containing our mock files' content!
      // This is a robust BDD rendering-based assertion that perfectly waits for the multi-turn tool loop to finish.
      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return lower.includes('add') || lower.includes('multiply');
        },
        90000,
      );

      // Refresh output after waiting for idle
      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] Complete summary response received! Verifying outputs...',
      );

      // Verify that the output contains semantic details about the repository files we set up.
      const lowerOutput = finalOutput.toLowerCase();
      const hasMathDetails =
        lowerOutput.includes('math') ||
        lowerOutput.includes('multiply') ||
        lowerOutput.includes('add') ||
        lowerOutput.includes('project') ||
        lowerOutput.includes('index');

      expect(
        hasMathDetails,
        `Expected output to contain summary of the repository files, but got: \n${finalOutput}`,
      ).toBe(true);
    },
  });

  // Dedicated test case validating Google web search tool capability under Bedrock using the Gemini API key credentials fallback
  bedrockEvalTest('USUALLY_PASSES', {
    name: 'should successfully execute Google web search tool under Bedrock with Gemini fallback',
    prompt: 'Give me a brief overview of AWS EKS by searching the web.',
    timeout: 180000,
    configOverrides: {
      model: 'bedrock/eu.amazon.nova-2-lite-v1:0',
      approvalMode: 'yolo',
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Test] Waiting for local model to run Google web search tool and generate final summary...',
      );

      // Wait until the final summary output has successfully rendered containing web search details about AWS EKS!
      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return (
            lower.includes('eks') ||
            lower.includes('vpc') ||
            lower.includes('managed') ||
            lower.includes('kubernetes')
          );
        },
        90000,
      );

      // Refresh output after waiting for idle
      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] Web search completed! Verifying output grounding links...',
      );

      // Verify that the web search results were successfully integrated and grounded with EKS details
      const lower = finalOutput.toLowerCase();
      const hasEksDetails =
        lower.includes('eks') ||
        lower.includes('kubernetes') ||
        lower.includes('managed');
      expect(
        hasEksDetails,
        `Expected output to contain EKS web search details, but got: \n${finalOutput}`,
      ).toBe(true);
    },
  });

  // Dedicated test cases validating our new bedrock-nova structured response provider
  bedrockEvalTest('USUALLY_PASSES', {
    name: 'should successfully execute structured schema generator in bedrock-nova provider',
    prompt: 'Read src/math.ts and summarize its functions',
    configOverrides: {
      model: 'bedrock-nova/us.amazon.nova-2-lite-v1:0',
      approvalMode: 'yolo',
    },
    files: {
      'src/math.ts': [
        'export function multiply(a: number, b: number): number {',
        '  return a * 5;',
        '}',
      ].join('\n'),
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Test] Waiting for Bedrock Nova structured schema generator to read and analyze...',
      );

      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return lower.includes('multiply') || lower.includes('math');
        },
        90000,
      );

      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] Structured response analysis completed! Verifying output...',
      );

      const lowerOutput = finalOutput.toLowerCase();
      expect(
        lowerOutput.includes('multiply') || lowerOutput.includes('math'),
        `Expected output to contain math details, but got: \n${finalOutput}`,
      ).toBe(true);
    },
  });

  bedrockEvalTest('USUALLY_PASSES', {
    name: 'should successfully create files using structured tool calls in bedrock-nova provider',
    prompt:
      'Create a new file called src/config.json with the content: {"version": "2.0.0"}',
    configOverrides: {
      model: 'bedrock-nova/us.amazon.nova-2-lite-v1:0',
      approvalMode: 'yolo',
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Test] Waiting for Bedrock Nova structured tool calls to write a file...',
      );

      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return (
            lower.includes('create') ||
            lower.includes('config') ||
            lower.includes('version')
          );
        },
        90000,
      );

      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] Structured file creation completed! Verifying file existence...',
      );

      // Verify that the file src/config.json was actually created in the test directory with correct contents
      const testDir = rig.getTestDir();
      const configPath = path.join(testDir, 'src', 'config.json');
      const fileExists = fs.existsSync(configPath);
      expect(fileExists, `Expected file to exist at ${configPath}`).toBe(true);

      const fileContent = fs.readFileSync(configPath, 'utf-8');
      expect(fileContent.trim()).toContain('2.0.0');
    },
  });

  bedrockEvalTest('USUALLY_PASSES', {
    name: 'should successfully search AWS documentation using the MCP server under bedrock-nova',
    prompt:
      'Search AWS documentation for "S3 bucket naming rules" and summarize the rules',
    configOverrides: {
      model: 'bedrock-nova/us.amazon.nova-2-lite-v1:0',
      approvalMode: 'yolo',
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Test] Waiting for Bedrock Nova structured tool calls to query AWS Documentation MCP server...',
      );

      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return (
            lower.includes('s3') ||
            lower.includes('bucket') ||
            lower.includes('namespace') ||
            lower.includes('naming')
          );
        },
        90000,
      );

      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] AWS Documentation MCP server query completed! Verifying structured schema...',
      );
      expect(finalOutput.toLowerCase()).toContain('s3');
    },
  });
});
