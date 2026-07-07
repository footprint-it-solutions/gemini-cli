/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, vi, beforeEach, afterEach, it } from 'vitest';
import { BedrockNovaAppRig } from '../packages/cli/src/test-utils/BedrockNovaAppRig.js';
import { clientCache } from '../packages/core/src/core/providers/bedrockNovaProvider.js';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { symlinkNodeModules } from '../evals/test-helper.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ConverseStreamCommand: class {},
  ConverseCommand: class {},
}));

const mockClient = {
  send: mockSend,
};

// Helper mock structures for AWS Bedrock Converse stream chunks
function createMockStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function waitUntil(
  rig: BedrockNovaAppRig,
  predicate: () => boolean | Promise<boolean>,
  timeout = 15000,
) {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out waiting for BDD assertions. Current TUI frame:\n${rig.getStaticOutput()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Bedrock Nova - Chaos Resilience Suite', () => {
  let rig: BedrockNovaAppRig;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_CLI_BEDROCK_USE_MICRO_CLASSIFIER', 'false');

    // Inject our mock client into the provider cache to bypass live AWS hits
    clientCache.clear();
    const region = 'eu-west-1';
    const profile = 'Aerith-Development';
    const cacheKey = `${region}:${profile}`;
    clientCache.set(cacheKey, mockClient as unknown as BedrockRuntimeClient);

    rig = new BedrockNovaAppRig({
      configOverrides: {
        model: 'bedrock-nova/eu.amazon.nova-2-lite-v1:0',
        approvalMode: 'yolo',
      },
    });

    await rig.initialize();
    symlinkNodeModules(rig.getTestDir());
  });

  afterEach(async () => {
    await rig.unmount();
    vi.unstubAllEnvs();
  });

  it('CHAOS: should NOT crash when tool_calls is an object instead of an array', async () => {
    // Replicates the reported bug: finalToolCalls.forEach is not a function
    const streamChunks = [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'c1', name: 'nova_response_schema' } },
          contentBlockIndex: 0,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'I am about to add a paragraph.',
                text: 'I am adding content to README.md.',
                // MALFORMED: tool_calls as object, not array
                tool_calls: {
                  '0': { name: 'read_file', arguments_json: '{}' },
                },
              }),
            },
          },
          contentBlockIndex: 0,
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    mockSend.mockResolvedValue({ stream: createMockStream(streamChunks) });

    await rig.render();
    await rig.sendMessage('Add content');

    // SUCCESS: The turn should complete without an [API Error] crash indicator in the TUI.
    // It should fallback to treating it as an empty array or reporting a safe error.
    await waitUntil(rig, () => {
      const output = rig.getStaticOutput() || '';
      return output.includes('adding content');
    });

    const finalOutput = rig.getStaticOutput();
    expect(finalOutput).not.toContain('forEach is not a function');
    expect(finalOutput).toContain('I am adding content');
  }, 30000);

  it('CHAOS: should handle truncated JSON fragments mid-key gracefully', async () => {
    const streamChunks = [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'c2', name: 'nova_response_schema' } },
          contentBlockIndex: 0,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: '{"thoughts": "thinking", "te', // TRUNCATED MID-KEY
            },
          },
          contentBlockIndex: 0,
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    mockSend.mockResolvedValue({ stream: createMockStream(streamChunks) });

    await rig.render();
    await rig.sendMessage('Truncate test');

    // Should finish without crashing
    await rig.waitForIdle();
    const finalOutput = rig.getStaticOutput();
    expect(finalOutput).not.toContain('Error');
  });
});
