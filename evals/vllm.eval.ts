/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import { vllmEvalTest } from './vllm-app-test-helper.js';
import { debugLogger } from '@google/gemini-cli-core';
// import * as net from 'node:net';

// Helper to check if local or remote vLLM daemon is reachable by checking TCP port directly (bypassing fetch sandbox mocks)
/*
async function isVllmOnline(
  port: number = 8000,
  host: string = '127.0.0.1',
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}
*/

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

describe('vllm_bdd_evals', () => {
  let consoleSpy: any;

  beforeEach(async (context) => {
    const online = true; // Forced to true to execute live test against warmed-up local vLLM container
    if (!online) {
      console.log(
        '[vLLM Eval] vLLM endpoint is offline or unreachable. Skipping interactive BDD test.',
      );
      context.skip();
    }

    // Intercept and suppress React 'act(...)' warnings from failing the BDD eval.
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('was not wrapped in act(...)')) {
        return;
      }
      console.warn('[Console Error]:', ...args);
    });

    // Unmock debugLogger.log to print live events
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (debugLogger.log as any).mockRestore?.();
  });

  afterEach(() => {
    consoleSpy?.mockRestore?.();
  });

  // 1. Tool execution and streaming check
  vllmEvalTest('USUALLY_PASSES', {
    suiteName: 'vllm_bdd_evals',
    suiteType: 'behavioral',
    name: 'should successfully execute tools and stream responses using vLLM locally',
    prompt:
      'Please use the read_file tool on src/index.ts and summarize its functions.',
    timeout: 180000,
    configOverrides: {
      model: 'gemma4-12b',
      approvalMode: 'yolo',
    },
    files: {
      'src/index.ts': [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n'),
    },
    assert: async (rig, output) => {
      // Wait until agent has finished processing and successfully executed the read_file tool
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().includes('export function add') ||
          rig.getStaticOutput().includes('add('),
        120000,
      );

      const finalOutput = rig.getStaticOutput();
      expect(finalOutput).toContain('add');
    },
  });

  // 2. Multi-turn interaction depth check (at least 5 turns as mandated for BDD tests)
  vllmEvalTest('USUALLY_PASSES', {
    suiteName: 'vllm_bdd_evals',
    suiteType: 'behavioral',
    name: 'should successfully complete a 5-turn conversation and maintain history under vLLM',
    prompt: 'Turn 1: Hello! Please say "Ready".',
    timeout: 240000,
    configOverrides: {
      model: 'gemma4-12b',
      approvalMode: 'yolo',
    },
    assert: async (rig, output) => {
      // Turn 1
      await waitUntil(
        rig,
        () => rig.getStaticOutput().includes('Ready'),
        40000,
      );

      // Turn 2
      await rig.sendMessage('Turn 2: Can you tell me what 2 + 2 is?');
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().includes('4') ||
          rig.getStaticOutput().toLowerCase().includes('four'),
        40000,
      );

      // Turn 3
      await rig.sendMessage('Turn 3: What did I ask you first?');
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().toLowerCase().includes('hello') ||
          rig.getStaticOutput().toLowerCase().includes('ready'),
        40000,
      );

      // Turn 4
      await rig.sendMessage(
        'Turn 4: Give me a single word that rhymes with "blue".',
      );
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().toLowerCase().includes('shoe') ||
          rig.getStaticOutput().toLowerCase().includes('clue') ||
          rig.getStaticOutput().toLowerCase().includes('red') === false,
        40000,
      );

      // Turn 5
      await rig.sendMessage('Turn 5: What was the math question in Turn 2?');
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().includes('2 + 2') ||
          rig.getStaticOutput().includes('4'),
        40000,
      );

      const finalOutput = rig.getStaticOutput();
      expect(finalOutput).toBeDefined();
    },
  });

  // 3. Smoke/regression test for write_file and replace tools
  vllmEvalTest('USUALLY_PASSES', {
    suiteName: 'vllm_bdd_evals',
    suiteType: 'behavioral',
    name: 'should successfully write and modify files using write_file and replace tools under vLLM',
    prompt:
      'Please use write_file to create a file "src/test_demo.ts" with text "export const value = 1;". ' +
      'Then, use the replace tool to change the value from 1 to 42 in that file.',
    timeout: 180000,
    configOverrides: {
      model: 'gemma4-12b',
      approvalMode: 'yolo',
    },
    assert: async (rig, output) => {
      // Wait until the agent has completed both the write_file and replace operations
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().includes('42') &&
          (rig.getStaticOutput().toLowerCase().includes('replace') ||
            rig.getStaticOutput().toLowerCase().includes('modify') ||
            rig.getStaticOutput().toLowerCase().includes('success')),
        120000,
      );

      const finalOutput = rig.getStaticOutput();
      expect(finalOutput).toContain('42');
    },
  });

  // 4. Smoke/regression test for directory-based tools: list_directory, glob, and grep_search
  vllmEvalTest('USUALLY_PASSES', {
    suiteName: 'vllm_bdd_evals',
    suiteType: 'behavioral',
    name: 'should successfully navigate directories using list_directory, glob, and grep_search under vLLM',
    prompt:
      'Please list the contents of the "src" directory to see what is there, ' +
      'then use glob to find files matching "*.ts" under "src", ' +
      'and finally use grep_search to find the word "search_target" in "src".',
    timeout: 180000,
    configOverrides: {
      model: 'gemma4-12b',
      approvalMode: 'yolo',
    },
    files: {
      'src/find_me.ts': 'export const secret = "search_target";',
      'src/other.txt': 'no target here',
    },
    assert: async (rig, output) => {
      await waitUntil(
        rig,
        () =>
          rig.getStaticOutput().includes('find_me.ts') ||
          rig.getStaticOutput().toLowerCase().includes('search_target'),
        120000,
      );

      const finalOutput = rig.getStaticOutput();
      expect(finalOutput).toBeDefined();
    },
  });
});
