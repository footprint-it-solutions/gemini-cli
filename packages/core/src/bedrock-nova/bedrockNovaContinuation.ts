/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Tool } from '@google/genai';
import { type SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { BedrockNovaContentGenerator } from '../core/providers/bedrockNovaProvider.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { LlmRole } from '../telemetry/types.js';
export interface ToolCallSummary {
  name: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

export interface BedrockNovaContinuationState {
  fallbackContinuationCount: number;
  lastFallbackToolFingerprint?: string;
  lastResponseTextLength?: number;
}

export type BedrockTurnTextKind =
  | 'empty'
  | 'answer'
  | 'question'
  | 'continuation_preamble'
  | 'mixed'
  | 'unknown';

export type BedrockTurnDecision =
  'continue' | 'stop' | 'ask_user' | 'uncertain';

export interface BedrockNovaProviderTurnStateMetadata {
  isStreaming: boolean;
  rawStopReason: string | null;
  responseText: string;
  emittedToolCallCount: number;
  stream: {
    sawAssistantText: boolean;
    sawContentBlockStop: boolean;
    sawToolUseStart: boolean;
    sawToolUseDelta: boolean;
    sawToolUseComplete: boolean;
    emittedAssistantTextBlockCount: number;
    emittedToolCallCount: number;
  };
}

export interface BedrockNovaTurnState {
  promptId: string;
  turnId: string;
  finishReason: string;
  rawStopReason: string | null;
  responseText: string;
  recentToolCalls: ToolCallSummary[];
  currentToolFingerprint: string;
  pendingToolCalls: number;
  textKind: BedrockTurnTextKind;
  decision: BedrockTurnDecision;
  appearsIncomplete: boolean;
  endsWithColon: boolean;
  endsWithQuestion: boolean;
  providerMetadata?: BedrockNovaProviderTurnStateMetadata;
}

export interface BedrockTurnClassifierResult {
  decision: BedrockTurnDecision;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
  reason: string;
  summary?: string;
  source: 'deterministic' | 'micro';
}

const BEDROCK_MICRO_CLASSIFIER_TOOL_NAME = 'classify_bedrock_turn';

const BEDROCK_MICRO_CLASSIFIER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['continue', 'stop', 'ask_user', 'uncertain'],
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    signals: {
      type: 'array',
      items: { type: 'string' },
    },
    reason: {
      type: 'string',
    },
    summary: {
      type: 'string',
      description: 'summary of the assessed output',
    },
  },
  required: ['decision', 'confidence', 'signals', 'reason', 'summary'],
};

export async function checkNextSpeakerBedrockNova(
  turnState: BedrockNovaTurnState,
  signal: AbortSignal,
  promptId: string,
  awsProfile?: string,
  logFilename?: string,
): Promise<BedrockTurnClassifierResult | null> {
  if (process.env['GEMINI_CLI_BEDROCK_USE_MICRO_CLASSIFIER'] === 'false') {
    return null;
  }

  const generator = new BedrockNovaContentGenerator(
    process.env['AWS_BEDROCK_REGION'] ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'],
    awsProfile || process.env['AWS_PROFILE'],
    logFilename,
  );
  const classifierModel =
    process.env['GEMINI_CLI_BEDROCK_MICRO_CLASSIFIER_MODEL'] ||
    'bedrock/eu.amazon.nova-micro-v1:0';
  const tool: Tool = {
    functionDeclarations: [
      {
        name: BEDROCK_MICRO_CLASSIFIER_TOOL_NAME,
        description:
          'Classify whether the primary Bedrock assistant should automatically continue, stop, or wait for the user after an ambiguous turn.',
        parametersJsonSchema: BEDROCK_MICRO_CLASSIFIER_SCHEMA,
      },
    ],
  };

  const payload = {
    promptId: turnState.promptId,
    turnId: turnState.turnId,
    finishReason: turnState.finishReason,
    rawStopReason: turnState.rawStopReason,
    responseText: turnState.responseText,
    textKind: turnState.textKind,
    appearsIncomplete: turnState.appearsIncomplete,
    endsWithColon: turnState.endsWithColon,
    endsWithQuestion: turnState.endsWithQuestion,
    pendingToolCalls: turnState.pendingToolCalls,
    recentToolCalls: turnState.recentToolCalls,
    providerMetadata: turnState.providerMetadata,
  };

  const classifierPrompt = [
    'You are classifying an ambiguous Bedrock assistant turn.',
    `Call the ${BEDROCK_MICRO_CLASSIFIER_TOOL_NAME} tool exactly once.`,
    'Choose continue only when the assistant likely intended to immediately keep working without waiting for the user.',
    'Choose ask_user only when the assistant is clearly asking the user for input.',
    'Choose stop when the assistant response looks complete.',
    'Choose uncertain when the evidence is mixed.',
    'Summarize the assistant end-of-turn output in the "summary" field.',
    `Turn payload: ${JSON.stringify(payload)}`,
  ].join(' ');

  try {
    debugLogger.debug(
      '[GeminiClient] Bedrock micro classifier invoked',
      JSON.stringify({
        promptId,
        turnId: turnState.turnId,
        classifierModel,
        finishReason: turnState.finishReason,
        rawStopReason: turnState.rawStopReason,
        textKind: turnState.textKind,
        responseText: turnState.responseText.slice(0, 160),
        pendingToolCalls: turnState.pendingToolCalls,
        recentToolCalls: turnState.recentToolCalls,
      }),
    );

    const response = await generator.generateContent(
      {
        model: classifierModel,
        contents: [{ role: 'user', parts: [{ text: classifierPrompt }] }],
        config: {
          temperature: 0,
          maxOutputTokens: 512,
          tools: [tool],
        },
      },
      `${promptId}-bedrock-micro-classifier`,
      LlmRole.UTILITY_NEXT_SPEAKER,
    );

    if (response && response.usageMetadata) {
      const inputTokens = response.usageMetadata.promptTokenCount || 0;
      const outputTokens = response.usageMetadata.candidatesTokenCount || 0;
      const totalTokens =
        response.usageMetadata.totalTokenCount || inputTokens + outputTokens;

      coreEvents.emit(CoreEvent.UtilityTokenUsage, {
        model: classifierModel,
        inputTokens,
        outputTokens,
        totalTokens,
        context: 'checkNextSpeakerBedrockNova',
      });
    }

    const toolCall =
      response.functionCalls && Array.isArray(response.functionCalls)
        ? response.functionCalls.find(
            (call: { name?: string }) =>
              call.name === BEDROCK_MICRO_CLASSIFIER_TOOL_NAME,
          )
        : undefined;
    if (
      !toolCall ||
      typeof toolCall.args !== 'object' ||
      toolCall.args === null
    ) {
      debugLogger.warn(
        '[GeminiClient] Bedrock micro classifier returned no tool call',
        JSON.stringify({
          promptId,
          turnId: turnState.turnId,
          responseText: turnState.responseText.slice(0, 160),
        }),
      );
      return null;
    }

    const args = toolCall.args;

    // Type guard functions for safer property access
    function getStringProp(
      obj: Record<string, unknown>,
      prop: string,
    ): string | null {
      const val = obj[prop];
      return typeof val === 'string' ? val : null;
    }

    function getStringPropOrEmpty(
      obj: Record<string, unknown>,
      prop: string,
    ): string {
      const val = obj[prop];
      return typeof val === 'string' ? val : '';
    }

    const decision = getStringProp(args, 'decision');
    const confidence = getStringProp(args, 'confidence');
    const reason = getStringPropOrEmpty(args, 'reason');
    const summary = getStringProp(args, 'summary');

    const signals = Array.isArray(args['signals'])
      ? (args['signals'] as unknown[]).filter(
          (signal): signal is string => typeof signal === 'string',
        )
      : [];

    function isBedrockTurnDecision(
      val: string | null,
    ): val is BedrockTurnDecision {
      return ['continue', 'stop', 'ask_user', 'uncertain'].includes(val || '');
    }

    function isConfidence(
      val: string | null,
    ): val is 'high' | 'medium' | 'low' {
      return ['high', 'medium', 'low'].includes(val || '');
    }

    if (
      !isBedrockTurnDecision(decision) ||
      !isConfidence(confidence) ||
      summary === null
    ) {
      debugLogger.warn(
        '[GeminiClient] Bedrock micro classifier returned invalid arguments',
        JSON.stringify({ promptId, turnId: turnState.turnId, args }),
      );
      return null;
    }

    debugLogger.debug(
      `[GeminiClient] Bedrock micro classifier summary: ${summary}`,
    );

    // After validation, we know these values are of the correct types
    const result: BedrockTurnClassifierResult = {
      decision,
      confidence,
      signals,
      reason,
      summary,
      source: 'micro',
    };

    debugLogger.debug(
      '[GeminiClient] Bedrock micro classifier result',
      JSON.stringify({
        promptId,
        turnId: turnState.turnId,
        classifierModel,
        result,
      }),
    );

    return result;
  } catch (error) {
    debugLogger.warn(
      '[GeminiClient] Bedrock micro classifier failed',
      JSON.stringify({
        promptId,
        turnId: turnState.turnId,
        error: getErrorMessage(error),
      }),
    );
    if (signal.aborted) {
      return null;
    }
    return null;
  }
}

export function shouldUseBedrockContinuationBudget(
  continuationState: BedrockNovaContinuationState,
): boolean {
  return continuationState.fallbackContinuationCount < 100;
}

export function shouldContinueBedrockFallbackChain(
  continuationState: BedrockNovaContinuationState,
  currentToolFingerprint: string,
  isForcedContinuation = false,
  currentResponseTextLength = 0,
): boolean {
  if (isForcedContinuation) {
    return true;
  }
  if (continuationState.fallbackContinuationCount === 0) {
    return true;
  }

  const hasToolProgress =
    Boolean(continuationState.lastFallbackToolFingerprint) &&
    continuationState.lastFallbackToolFingerprint !== currentToolFingerprint;

  const hasTextProgress =
    continuationState.lastResponseTextLength !== undefined &&
    currentResponseTextLength > continuationState.lastResponseTextLength;

  return hasToolProgress || hasTextProgress;
}

/**
 * Detects if the current assistant monologue contains repetitive loop patterns or excessive
 * "analysis paralysis" thinking without actions.
 */
export function detectMonologueRepetition(text: string): {
  isLoop: boolean;
  reason: string;
} {
  if (!text) {
    return { isLoop: false, reason: '' };
  }

  const lower = text.toLowerCase();

  // Pattern 1: Count individual occurrences of common hesitation phrases.
  // If the same exact hesitation phrase is repeated multiple times in a single turn, it is a loop.
  const triggers = [
    { pattern: /\blet me\b/g, limit: 3, name: '"let me"' },
    { pattern: /\bactually\b/g, limit: 3, name: '"actually"' },
    { pattern: /\bbut first\b/g, limit: 3, name: '"but first"' },
    { pattern: /\bgoing in circles\b/g, limit: 2, name: '"going in circles"' },
    { pattern: /\bstep back\b/g, limit: 2, name: '"step back"' },
    { pattern: /\bi realize\b/g, limit: 3, name: '"I realize"' },
    { pattern: /\blet us\b/g, limit: 3, name: '"let us"' },
  ];

  for (const trigger of triggers) {
    const matches = lower.match(trigger.pattern);
    if (matches && matches.length >= trigger.limit) {
      return {
        isLoop: true,
        reason: `Repetition of phrase ${trigger.name} detected (${matches.length} times)`,
      };
    }
  }

  // Pattern 2: Concentration of hesitation phrases
  const hesitationPhrases = [
    'let me',
    'actually',
    'but first',
    'going in circles',
    'step back',
    'i realize',
    'let us',
  ];

  let hesitationCount = 0;
  for (const phrase of hesitationPhrases) {
    const regex = new RegExp(`\\b${phrase}\\b`, 'gi');
    const matches = text.match(regex);
    if (matches) {
      hesitationCount += matches.length;
    }
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 5 && words.length < 300 && hesitationCount >= 4) {
    return {
      isLoop: true,
      reason: `High concentration of hesitation phrases (${hesitationCount} phrases in ${words.length} words)`,
    };
  }

  return { isLoop: false, reason: '' };
}

/**
 * Appends custom guidelines targeting Bedrock Nova repetition loops.
 */
export function enhanceBedrockSystemPrompt(
  system: SystemContentBlock[] | undefined,
): SystemContentBlock[] | undefined {
  if (!system) return undefined;

  return [
    ...system,
    {
      text: `
[CRITICAL BEHAVIORAL RULE FOR BEDROCK NOVA]
- You are prone to repeating yourself in internal monologues (e.g. "Let me check...", "Actually, let me...", "But first, let me check..."). This is strictly forbidden.
- NEVER generate planning thoughts that begin with "Let me", "Actually", "Next, I will", "But first", or "I think".
- If you need to search or read a file, execute the tool call directly. Do not announce it, do not plan it, and do not debate it.
- DO NOT output any user-visible text or thought blocks before a tool call. If you decide to call a tool, your entire output for that chunk must be ONLY the tool call itself.
- If you find yourself repeating the same thoughts or actions, STOP immediately and ask the user a direct question instead of looping.`,
    },
  ];
}
