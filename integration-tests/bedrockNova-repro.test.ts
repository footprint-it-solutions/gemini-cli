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

// Mock the AWS SDK to bypass live credential discovery
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
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timed out waiting for BDD assertions. Current TUI frame:\n${rig.getStaticOutput()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- TEST SUITE ---

describe('Bedrock Nova - Bug Reproduction Bench', () => {
  let rig: BedrockNovaAppRig;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_CLI_BEDROCK_USE_MICRO_CLASSIFIER', 'false');

    // Inject our mock client into the provider cache before initialization
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

  it('REPRO: should NOT end turn prematurely if intermediate stream chunk contains finishReason: STOP', async () => {
    const streamChunks = [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'u1', name: 'nova_response_schema' } },
          contentBlockIndex: 0,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Thinking...',
                text: 'Part 1 of my long response. ',
                tool_calls: [],
              }),
            },
          },
          contentBlockIndex: 0,
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 'u2', name: 'nova_response_schema' } },
          contentBlockIndex: 1,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Still thinking...',
                text: 'Part 2 of my response.',
                tool_calls: [],
              }),
            },
          },
          contentBlockIndex: 1,
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    mockSend.mockResolvedValue({ stream: createMockStream(streamChunks) });

    await rig.render();
    await rig.sendMessage('Tell me a long story');

    await waitUntil(
      rig,
      () => {
        const output = rig.getStaticOutput() || '';
        return output.includes('Part 2');
      },
      15000,
    );

    const finalOutput = rig.getStaticOutput();
    expect(finalOutput).toContain('Part 1');
    expect(finalOutput).toContain('Part 2');
  });

  it('REPRO: should reconstruct history as a single toolUse block to prevent preamble loops', async () => {
    const turn1Chunks = [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 't1', name: 'nova_response_schema' } },
          contentBlockIndex: 0,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Starting analysis...',
                text: 'I am analyzing the code.',
                tool_calls: [],
              }),
            },
          },
          contentBlockIndex: 0,
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    const turn2Chunks = [
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: 't2', name: 'nova_response_schema' } },
          contentBlockIndex: 0,
        },
      },
      {
        contentBlockDelta: {
          delta: {
            toolUse: {
              input: JSON.stringify({
                thoughts: 'Done.',
                text: 'Analysis complete.',
                tool_calls: [],
              }),
            },
          },
          contentBlockIndex: 0,
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
    ];

    mockSend
      .mockResolvedValueOnce({ stream: createMockStream(turn1Chunks) })
      .mockResolvedValueOnce({ stream: createMockStream(turn2Chunks) });

    await rig.render();

    await rig.sendMessage('Analyze code');
    await waitUntil(rig, () =>
      rig.getStaticOutput().includes('analyzing the code'),
    );

    await rig.sendMessage('Continue');
    await waitUntil(rig, () =>
      rig.getStaticOutput().includes('Analysis complete'),
    );

    expect(mockSend).toHaveBeenCalledTimes(2);
    const secondCall = mockSend.mock.calls[1][0];
    const messages = secondCall.input.messages;

    const assistantHistory = messages[1];
    expect(assistantHistory.role).toBe('assistant');
    expect(assistantHistory.content[0].toolUse).toBeDefined();
    expect(assistantHistory.content[0].toolUse.name).toBe(
      'nova_response_schema',
    );

    const hasTextPart = assistantHistory.content.some(
      (c: { text?: string }) => c.text,
    );
    expect(hasTextPart).toBe(false);
  });
});
