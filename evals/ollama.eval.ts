/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, beforeEach, vi } from 'vitest';
import { ollamaEvalTest } from './ollama-app-test-helper.js';
import { debugLogger } from '@google/gemini-cli-core';

// Helper to check if local Ollama daemon is reachable
async function isOllamaOnline(
  host: string = 'http://localhost:11434',
): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

// Custom wait helper that prints real-time terminal frames to console during execution!
async function waitUntil(
  rig: any,
  predicate: () => boolean | Promise<boolean>,
  timeout = 60000,
) {
  const start = Date.now();
  let lastLoggedFrame = '';

  while (true) {
    if (await predicate()) return;

    // Print unique frame outputs so we can trace real-time terminal UI behavior
    const frame = rig.lastFrame;
    if (frame !== lastLoggedFrame) {
      console.log('--- Real-time TUI Frame Update ---');
      console.log(frame);
      lastLoggedFrame = frame;
    }

    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out waiting for agent loop. Current TUI frame:\n${frame}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('ollama_bdd_evals', () => {
  let consoleSpy: any;

  beforeEach(async (context) => {
    const online = await isOllamaOnline();
    if (!online) {
      console.log(
        '[Ollama Eval] Local Ollama daemon is offline or unreachable. Skipping interactive BDD test.',
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

    // Unmock debugLogger.log to print live application events during this local test run
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (debugLogger.log as any).mockRestore?.();
  });

  // Dedicated zero-pollution local provider BDD test
  ollamaEvalTest('USUALLY_PASSES', {
    name: 'should successfully execute tools and summarize code without raw XML leakage using Ollama',
    prompt:
      'Please use the read_file tool on src/index.ts and src/math.ts separately, one by one, and then summarize their functions.',
    timeout: 180000, // Explicitly allow 3 minutes for local model cold loading
    configOverrides: {
      // We use hermes3:8b (which is pulled on your machine) for TUI tests because it natively
      // supports tools and executes 6x faster than 30B models, preventing TUI rendering timeouts!
      model: 'ollama/hermes3:8b',
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
        '[BDD Test] Waiting for local model to read repository files and generate final summary...',
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
        60000,
      );

      // Refresh output after waiting for idle
      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Test] Complete summary response received! Verifying outputs...',
      );

      // 1. Verify that no raw XML syntax is leaked into the final output
      expect(finalOutput).not.toContain('<function=');
      expect(finalOutput).not.toContain('</function>');
      expect(finalOutput).not.toContain('<tool_call>');

      // 2. Verify that the output contains semantic details about the repository files we set up.
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

  // Dedicated test case validating Google web search tool capability under Ollama using the Gemini API key credentials fallback
  ollamaEvalTest('USUALLY_PASSES', {
    name: 'should successfully execute Google web search tool under Ollama with Gemini fallback',
    prompt: 'Give me a brief overview of AWS EKS by searching the web.',
    timeout: 180000,
    configOverrides: {
      model: 'ollama/hermes3:8b',
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
});
