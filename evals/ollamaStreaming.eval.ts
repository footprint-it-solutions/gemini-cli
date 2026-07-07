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

// Custom wait helper that prints real-time terminal frames to console during execution
async function waitUntil(
  rig: any,
  predicate: () => boolean | Promise<boolean>,
  timeout = 150000,
) {
  const start = Date.now();
  let lastLoggedFrame = '';

  while (true) {
    if (await predicate()) return;

    // Print unique frame outputs so we can trace real-time terminal UI behavior
    const frame = rig.lastFrame;
    if (frame !== lastLoggedFrame) {
      console.log('--- Real-time Streaming TUI Frame Update ---');
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

describe('ollama_streaming_bdd_evals', () => {
  let consoleSpy: any;

  beforeEach(async (context) => {
    const online = await isOllamaOnline();
    if (!online) {
      console.log(
        '[Ollama Stream Eval] Local Ollama daemon is offline or unreachable at 127.0.0.1. Skipping streaming BDD test.',
      );
      context.skip();
    }

    // Suppress React "act(...)" warnings from flooding output
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('was not wrapped in act(...)')) {
        return;
      }
      console.warn('[Console Error]:', ...args);
    });

    // Unmock debugLogger.log to print live application events during this local test run
    (debugLogger.log as any).mockRestore?.();
  });

  ollamaEvalTest('USUALLY_PASSES', {
    name: 'should stream responses, execute tools, and cleanly intercept XML block tool calls end-to-end',
    prompt:
      'Please use the read_file tool directly to read the file src/index.ts and then summarize its function. Do not invoke any subagents, do not activate any skills, and do not ask any questions or seek confirmation. Execute the tool immediately in your very first response turn without talking to me first. Run the tool yourself.',
    timeout: 240000, // Cold loading fallback (4 minutes total)
    configOverrides: {
      model: 'ollama-stream/gemini-cli-llama',
      approvalMode: 'yolo',
    },
    files: {
      'src/index.ts': [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
      ].join('\n'),
      'package.json': JSON.stringify(
        {
          name: 'stream-test-project',
          version: '1.0.0',
        },
        null,
        2,
      ),
    },
    assert: async (rig, output) => {
      console.log(
        '[BDD Streaming Test] Waiting for local streaming model to read repository files and generate final summary...',
      );

      // Wait until the final summary output has successfully rendered containing our index's content!
      await waitUntil(
        rig,
        () => {
          const frame = rig.getStaticOutput() || '';
          const lower = frame.toLowerCase();
          return lower.includes('greet') || lower.includes('hello');
        },
        180000, // 3 minutes wait for full loop execution
      );

      // Refresh output after waiting for idle
      const finalOutput = rig.getStaticOutput();
      console.log(
        '[BDD Streaming Test] Completed! Verifying outputs for cleanliness...',
      );

      // Verify that no raw XML syntax is leaked into the final output
      expect(finalOutput).not.toContain('<tool_call>');
      expect(finalOutput).not.toContain('</tool_call>');

      // Verify that the output contains semantic details about the repository files we set up
      const lowerOutput = finalOutput.toLowerCase();
      expect(
        lowerOutput.includes('greet') || lowerOutput.includes('hello'),
        `Expected output to contain summary of greet function, but got: \n${finalOutput}`,
      ).toBe(true);
    },
  });
});
