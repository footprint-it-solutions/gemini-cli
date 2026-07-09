/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, vi, beforeEach, afterEach, it } from 'vitest';
import { BedrockNovaAppRig } from '../packages/cli/src/test-utils/BedrockNovaAppRig.js';
import { AuthType } from '@google/gemini-cli-core';
import { act } from 'react';
import { clientCache } from '../packages/core/src/core/providers/bedrockNovaProvider.js';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { symlinkNodeModules } from '../evals/test-helper.js';

// --- MOCKS ---

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    ConverseCommand: vi.fn().mockImplementation((input) => ({ input })),
    ConverseStreamCommand: vi.fn().mockImplementation((input) => ({ input })),
  };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn().mockReturnValue(() =>
    Promise.resolve({
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    }),
  ),
}));

const mockClient = {
  send: mockSend,
};

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
  timeout = 30000,
) {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    console.log('WAITING... mockSend calls:', mockSend.mock.calls.length);
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out waiting for BDD assertions. Current TUI frame:\n${rig.getStaticOutput()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- TEST SUITE ---

describe('Bedrock Nova - Integration and Reliability Bench (BDD)', () => {
  let rig: BedrockNovaAppRig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSend.mockReset();
    vi.stubEnv('GEMINI_CLI_BEDROCK_USE_MICRO_CLASSIFIER', 'false');

    // Inject mock client into cached provider
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
    vi.stubEnv('GEMINI_DEFAULT_AUTH_TYPE', AuthType.BEDROCK_NOVA);
    await act(async () => {
      await rig.getConfig().refreshAuth(AuthType.BEDROCK_NOVA);
    });
    symlinkNodeModules(rig.getTestDir());
  });

  afterEach(async () => {
    await rig.unmount();
    vi.unstubAllEnvs();
  });

  it('should trigger empty response circuit-breaker once and recover with visible output', async () => {
    // 1. Initial turn: Model returns an empty stream delta (empty thoughts, empty text)
    const emptyResponseStream = createMockStream([
      {
        contentBlockStart: {
          start: {
            toolUse: {
              toolUseId: 'call_nova_empty',
              name: 'nova_response_schema',
            },
          },
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: '',
                text: '   ',
                tool_calls: [],
              }),
            },
          },
        },
      },
      {
        contentBlockStop: {},
      },
      {
        messageStop: {
          stopReason: 'end_turn',
        },
      },
    ]);

    // Setup sequence of mocked calls to the ConverseStreamCommand API
    mockSend.mockResolvedValueOnce({ stream: emptyResponseStream });

    // Render and send a message via CLI Rig
    await rig.render();
    await rig.sendMessage('Generate update');

    // Wait until the fallback text renders in the terminal
    await waitUntil(
      rig,
      () => rig.getStaticOutput().includes('returned an empty response'),
      15000,
    );

    // Assert that the circuit-breaker triggered the reprompt text
    expect(rig.getStaticOutput()).toContain('returned an empty response');
    expect(mockSend).toHaveBeenCalledTimes(1);
  }, 30000);

  it('should compress and prune conversational history during multi-turn auto-continuations', async () => {
    // 1. Runaway stream chunk (simulating finishReason MAX_TOKENS)
    const runawayStream = createMockStream([
      {
        contentBlockStart: {
          start: {
            toolUse: {
              toolUseId: 'call_runaway',
              name: 'nova_response_schema',
            },
          },
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Generating large output...',
                text: 'Step 1: Process is ongoing...',
                tool_calls: [],
              }),
            },
          },
        },
      },
      {
        contentBlockStop: {},
      },
      {
        messageStop: {
          stopReason: 'max_tokens', // Trigger continuation
        },
      },
    ]);

    // 2. Continuous continuation streams
    const continuationStream = createMockStream([
      {
        contentBlockStart: {
          start: {
            toolUse: {
              toolUseId: 'call_cont',
              name: 'nova_response_schema',
            },
          },
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Continuing with task...',
                text: 'Step 2: Task completed successfully.',
                tool_calls: [],
              }),
            },
          },
        },
      },
      {
        contentBlockStop: {},
      },
      {
        messageStop: {
          stopReason: 'end_turn',
        },
      },
    ]);

    mockSend
      .mockResolvedValueOnce({ stream: runawayStream })
      .mockResolvedValueOnce({ stream: continuationStream });

    await rig.render();
    await rig.sendMessage('Run multi-turn process');

    await waitUntil(
      rig,
      () => rig.getStaticOutput().includes('Step 2: Task completed'),
      15000,
    );

    expect(rig.getStaticOutput()).toContain('Step 1: Process is ongoing...');
    expect(rig.getStaticOutput()).toContain('Step 2: Task completed');
  }, 30000);
});
