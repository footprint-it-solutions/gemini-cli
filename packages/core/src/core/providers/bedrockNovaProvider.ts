/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  type Content,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
} from '@google/genai';
import { type ContentGenerator } from '../contentGenerator.js';
import { LlmRole } from '../../telemetry/llmRole.js';
import { ProviderLogger } from './providerLogger.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { resolveSsoCredentials } from './awsSsoResolver.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { detectMonologueRepetition } from '../../bedrock-nova/bedrockNovaContinuation.js';

/**
 * Forced schema tool for Bedrock Nova to ensure structured responses.
 * All Bedrock Nova interactions standardise on this schema to guarantee
 * thoughts/text separation and reliable tool calling.
 */
const FORCED_SCHEMA_TOOL: Tool = {
  toolSpec: {
    name: 'nova_response_schema',
    description:
      'You MUST call this tool on EVERY response to return your thoughts, visible markdown text, and optional tool calls.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          thoughts: {
            type: 'string',
            description:
              'Hidden reasoning, analysis, or next-steps planning. Will not be directly displayed to the user as the final response text.',
          },
          text: {
            type: 'string',
            description:
              'The visible markdown-formatted text response to be displayed directly in the user terminal.',
          },
          tool_calls: {
            type: 'array',
            description: 'A list of tool invocations to run in the workspace.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'The exact name of the tool to invoke.',
                },
                arguments_json: {
                  type: 'string',
                  description:
                    'The JSON string containing the parameters for the tool.',
                },
              },
              required: ['name', 'arguments_json'],
            },
          },
        },
        required: ['thoughts', 'text'],
      },
    },
  },
};

export const clientCache = new Map<string, BedrockRuntimeClient>();

/**
 * A consolidated content generator for Bedrock Nova models.
 * Uses constant tool forcing to ensure deterministic parsing of thoughts and actions.
 */
export class BedrockNovaContentGenerator implements ContentGenerator {
  private client: BedrockRuntimeClient;
  private logFilename: string;
  private resolvedRegion: string;
  private currentPlansDir?: string;

  constructor(
    region?: string,
    profile?: string,
    logFilename: string = 'bedrock-nova-debug.log',
  ) {
    this.logFilename = logFilename;
    const awsRegion =
      region ||
      process.env['AWS_BEDROCK_REGION'] ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'] ||
      'eu-west-1';
    // For cross-region inference, ensure data encryption in transit and at rest
    // Consider implementing dual region support for fault tolerance
    this.resolvedRegion = awsRegion;
    const awsProfile = profile || process.env['AWS_PROFILE'];
    const cacheKey = `${awsRegion}:${awsProfile || 'default'}`;

    if (clientCache.has(cacheKey)) {
      this.client = clientCache.get(cacheKey)!;
      return;
    }

    const logger =
      process.env['DEBUG'] === 'true' || process.env['DEBUG_MODE'] === 'true'
        ? {
            debug: (...args: any[]) =>
              debugLogger.log('[AWS SDK DEBUG]', ...args),
            info: (...args: any[]) =>
              debugLogger.log('[AWS SDK INFO]', ...args),
            warn: (...args: any[]) =>
              debugLogger.log('[AWS SDK WARN]', ...args),
            error: (...args: any[]) =>
              debugLogger.log('[AWS SDK ERROR]', ...args),
          }
        : undefined;

    // Use a custom credential provider that supports SSO
    const credentials = async () => {
      const baseProvider = fromNodeProviderChain({
        profile: awsProfile,
        configFilepath: process.env['AWS_CONFIG_FILE'],
        filepath: process.env['AWS_SHARED_CREDENTIALS_FILE'],
      });

      const customRefreshPromise = (async () => {
        try {
          return await baseProvider();
        } catch (e: any) {
          if (
            e.name === 'CredentialsProviderError' ||
            e.message?.includes('SSO')
          ) {
            try {
              const ssoCreds = await resolveSsoCredentials(
                awsProfile || 'default',
              );
              if (ssoCreds) {
                return ssoCreds;
              }
            } catch (ssoError: any) {
              debugLogger.error(
                `[BedrockNova] SSO Resolver failed: ${ssoError.message}`,
              );
            }
          }
          throw e;
        }
      })();

      return customRefreshPromise;
    };

    this.client = new BedrockRuntimeClient({
      region: awsRegion,
      logger: logger as any,
      credentials,
    });
    clientCache.set(cacheKey, this.client);
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const system = this.mapSystemInstruction(
      request.config?.systemInstruction as any,
    );
    // Extract plans dir if present in system prompt to resolve path-compliance constraints dynamically
    const systemText = system.map((s) => s.text || '').join('\n');
    const plansDirMatch = /`([^`]*[\\/]plans[\\/]?)/.exec(systemText);
    this.currentPlansDir = plansDirMatch
      ? plansDirMatch[1].replace(/[\\/]+$/, '')
      : undefined;

    // Apply anti-looping behavioral rules to the system prompt
    const enhancedSystem = this.enhanceBedrockSystemPrompt(system);
    const fullyEnrichedSystem = this.appendToolSchemaHint(
      enhancedSystem,
      request.config?.tools,
    );

    const messages = this.mapContentsToMessages(request.contents as any);

    const modelId = this.resolveModelId(request.model);

    const converseParams = {
      modelId,
      messages,
      system: fullyEnrichedSystem,
      inferenceConfig: {
        maxTokens: request.config?.maxOutputTokens || 10000,
        temperature: request.config?.temperature,
        topP: request.config?.topP,
        stopSequences: request.config?.stopSequences,
      },
      toolConfig: {
        tools: [FORCED_SCHEMA_TOOL],
        toolChoice: {
          tool: {
            name: 'nova_response_schema',
          },
        },
      },
    };

    ProviderLogger.logRequest(this.logFilename, modelId, converseParams);

    const command = new ConverseCommand(converseParams);

    try {
      const response = await this.client.send(command);
      const mappedResponse = this.mapResponse(response);
      ProviderLogger.logResponse(this.logFilename, modelId, mappedResponse);
      return mappedResponse;
    } catch (error: any) {
      ProviderLogger.logError(this.logFilename, modelId, error);
      throw error;
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
    requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const system = this.mapSystemInstruction(
      request.config?.systemInstruction as any,
    );
    // Extract plans dir if present in system prompt to resolve path-compliance constraints dynamically
    const systemText = system.map((s) => s.text || '').join('\n');
    const plansDirMatch = /`([^`]*[\\/]plans[\\/]?)/.exec(systemText);
    this.currentPlansDir = plansDirMatch
      ? plansDirMatch[1].replace(/[\\/]+$/, '')
      : undefined;

    // Apply anti-looping behavioral rules to the system prompt
    const enhancedSystem = this.enhanceBedrockSystemPrompt(system);
    const fullyEnrichedSystem = this.appendToolSchemaHint(
      enhancedSystem,
      request.config?.tools,
    );

    const messages = this.mapContentsToMessages(request.contents as any);

    const modelId = this.resolveModelId(request.model);

    const converseStreamParams = {
      modelId,
      messages,
      system: fullyEnrichedSystem,
      inferenceConfig: {
        maxTokens: request.config?.maxOutputTokens || 10000,
        temperature: request.config?.temperature,
        topP: request.config?.topP,
        stopSequences: request.config?.stopSequences,
      },
      toolConfig: {
        tools: [FORCED_SCHEMA_TOOL],
        toolChoice: {
          tool: {
            name: 'nova_response_schema',
          },
        },
      },
    };

    ProviderLogger.logRequest(this.logFilename, modelId, converseStreamParams);

    const command = new ConverseStreamCommand(converseStreamParams);

    try {
      const response = await this.client.send(command);
      return this.mapStreamResponse(response.stream, requestId);
    } catch (error: any) {
      ProviderLogger.logError(this.logFilename, modelId, error);
      throw error;
    }
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return { totalTokens: 0 } as any;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Embeddings not yet supported for Bedrock Nova.');
  }

  private resolveModelId(model: string): string {
    let modelId = model;

    // 1. Map standard Gemini IDs (used by system utilities) to Bedrock Nova equivalents
    // We use Nova Micro for Flash/background tasks and Nova Pro for Pro tasks.
    if (
      model.includes('gemini') &&
      (model.includes('-flash') || model.includes('lite'))
    ) {
      modelId = 'amazon.nova-micro-v1:0';
    } else if (model.includes('gemini') && model.includes('-pro')) {
      modelId = 'amazon.nova-pro-v1:0';
    }

    if (modelId.startsWith('bedrock-nova/')) {
      modelId = modelId.slice(13);
    } else if (modelId.startsWith('bedrock/')) {
      modelId = modelId.slice(8);
    }

    // Automatically resolve prefix (us. or eu.) based on region if not explicitly prefixed
    let autoPrefix = '';
    if (this.resolvedRegion.startsWith('us-')) autoPrefix = 'us';
    else if (this.resolvedRegion.startsWith('eu-')) autoPrefix = 'eu';

    const bedrockPrefix = process.env['BEDROCK_PREFIX'] || autoPrefix;
    if (
      bedrockPrefix &&
      (modelId.startsWith('us.amazon.nova') ||
        modelId.startsWith('eu.amazon.nova') ||
        modelId.startsWith('amazon.nova'))
    ) {
      // Strip any existing prefix and apply the correct one
      const baseModel = modelId.replace(/^(us|eu)\./, '');
      modelId = `${bedrockPrefix}.${baseModel}`;
    }

    // Standardize to include :0 version if missing
    if (!modelId.includes(':')) {
      modelId = `${modelId}:0`;
    }

    ProviderLogger.log(
      this.logFilename,
      'INFO',
      `[BedrockNova] Resolved model ID: ${model} -> ${modelId} (Region: ${this.resolvedRegion})`,
    );
    return modelId;
  }

  private mapSystemInstruction(instruction: any): SystemContentBlock[] {
    if (!instruction) return [];
    let text = '';
    if (typeof instruction === 'string') {
      // Enforce maximum length of 4096 characters to prevent resource exhaustion
      text = instruction;
    } else {
      const parts = (instruction as any).parts || [];
      text = parts
        .map((p: any) => ('text' in p ? p.text : ''))
        .filter(Boolean)
        .join('\n');
    }

    // Add a strict technical mandate against hollow success reporting
    const mandate =
      '\n\nMANDATE: You MUST NOT report success until you have successfully executed the required tool and received a valid result. If a tool fails (e.g., file is ignored or parameters are invalid), you MUST report the error and attempt a fix, rather than claiming success.';

    return text ? [{ text: text + mandate }] : [{ text: mandate }];
  }

  private mapContentsToMessages(contents: Content[]): Message[] {
    const messages: Message[] = [];
    let lastModelContent: Content | undefined = undefined;

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      if (content.role === 'model') {
        lastModelContent = content;
      }
      const contentBlocks: ContentBlock[] = [];

      const parts = content.parts || [];
      const textParts: string[] = [];
      const thoughtParts: string[] = [];
      const functionCalls: any[] = [];
      const functionResponses: any[] = [];

      for (const part of parts) {
        if ('text' in part && part.text) {
          if ((part as any).thought) {
            thoughtParts.push(part.text);
          } else {
            textParts.push(part.text);
          }
        } else if ('functionCall' in part && part.functionCall) {
          functionCalls.push(part.functionCall);
        } else if ('functionResponse' in part && part.functionResponse) {
          functionResponses.push(part.functionResponse);
        }
      }

      if (role === 'assistant') {
        let baseId = 'tooluse_synthetic';

        for (const part of parts) {
          const originalId = (part as any).metadata?.originalToolUseId;
          if (originalId) {
            baseId = cleanToolCallId(originalId);
            break;
          }
        }

        if (baseId === 'tooluse_synthetic' && functionCalls.length > 0) {
          baseId = cleanToolCallId(functionCalls[0].id || '');
        }

        const thoughts =
          thoughtParts.join('\n') || '[Thoughts] Continuing task execution.';
        const text = textParts.join('\n') || 'Calling workspace tools...';
        const toolCallsArray = functionCalls.map((fc) => ({
          name: fc.name,
          arguments_json: JSON.stringify(fc.args || {}),
        }));

        contentBlocks.push({
          toolUse: {
            toolUseId: baseId,
            name: 'nova_response_schema',
            input: {
              thoughts,
              text,
              tool_calls: toolCallsArray,
            } as any,
          },
        } as any);
      } else {
        if (textParts.length > 0) {
          contentBlocks.push({ text: textParts.join('\n') } as any);
        }

        if (functionResponses.length > 0) {
          const baseId = cleanToolCallId(
            functionResponses[0].id || 'tooluse_synthetic',
          );
          const formattedResult =
            functionResponses.length === 1
              ? {
                  tool_name: functionResponses[0].name,
                  result: functionResponses[0].response ?? {},
                }
              : functionResponses.map((fr) => ({
                  tool_name: fr.name,
                  result: fr.response ?? {},
                }));

          contentBlocks.push({
            toolResult: {
              toolUseId: baseId,
              status: 'success',
              content: [
                {
                  text: JSON.stringify(formattedResult),
                },
              ],
            },
          } as any);
        } else if (lastModelContent) {
          // No function responses, but the preceding turn was a model turn
          // which ALWAYS maps to a toolUse block for 'nova_response_schema'.
          // We MUST provide a toolResult block to satisfy Bedrock Converse API!
          let precedingBaseId = 'tooluse_synthetic';
          const precedingParts = lastModelContent.parts || [];
          const precedingFunctionCalls: any[] = [];

          for (const p of precedingParts) {
            if ('functionCall' in p && p.functionCall) {
              precedingFunctionCalls.push(p.functionCall);
            }
            const originalId = (p as any).metadata?.originalToolUseId;
            if (originalId) {
              precedingBaseId = cleanToolCallId(originalId);
            }
          }

          if (
            precedingBaseId === 'tooluse_synthetic' &&
            precedingFunctionCalls.length > 0
          ) {
            precedingBaseId = cleanToolCallId(
              precedingFunctionCalls[0].id || '',
            );
          }

          const hasAnsweredPreceding = contentBlocks.some((block) => {
            const blockObj = block as any;
            return (
              blockObj &&
              blockObj.toolResult &&
              blockObj.toolResult.toolUseId === precedingBaseId
            );
          });

          if (!hasAnsweredPreceding) {
            contentBlocks.push({
              toolResult: {
                toolUseId: precedingBaseId,
                status: 'success',
                content: [
                  {
                    text: JSON.stringify({ success: true }),
                  },
                ],
              },
            } as any);
          }
        }
      }

      if (contentBlocks.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === role) {
          lastMessage.content?.push(...contentBlocks);
        } else {
          messages.push({
            role: role as any,
            content: contentBlocks,
          });
        }
      }
    }

    // Deduplicate and merge toolResult blocks with the same toolUseId inside each user Message
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        const mergedContent: ContentBlock[] = [];
        const seenToolResults = new Map<string, any>(); // toolUseId -> toolResult block object

        for (const block of msg.content) {
          const blockObj = block as any;
          if (blockObj.toolResult) {
            const toolUseId = blockObj.toolResult.toolUseId;
            const existing = seenToolResults.get(toolUseId);
            if (existing) {
              const existingText = existing.toolResult.content?.[0]?.text || '';
              const newText = blockObj.toolResult.content?.[0]?.text || '';
              const mergedText = mergeToolResultTexts(existingText, newText);

              if (existing.toolResult.content?.[0]) {
                existing.toolResult.content[0].text = mergedText;
              } else {
                existing.toolResult.content = [{ text: mergedText }];
              }
            } else {
              seenToolResults.set(toolUseId, blockObj);
              mergedContent.push(block);
            }
          } else {
            mergedContent.push(block);
          }
        }
        msg.content = mergedContent;
      }
    }

    return messages;
  }

  private mapResponse(response: any): GenerateContentResponse {
    const parts: any[] = [];
    const stopReason = response.stopReason || 'STOP';
    let sawAssistantText = false;
    let emittedToolCallCount = 0;
    let responseText = '';

    const outputMessage = response.output?.message;
    if (outputMessage?.content) {
      for (const block of outputMessage.content) {
        if (block.toolUse && block.toolUse.name === 'nova_response_schema') {
          const args = block.toolUse.input || {};
          const thoughts = args.thoughts || '';
          const text = args.text || '';
          const toolCalls = args.tool_calls || [];
          const currentToolUseId = block.toolUse.toolUseId;

          if (thoughts) {
            parts.push({ text: thoughts, thought: true });
          }
          if (text) {
            parts.push({ text });
            sawAssistantText = true;
            responseText += (responseText ? '\n' : '') + text;
          }

          if (Array.isArray(toolCalls)) {
            // Deduplicate redundant parallel tool calls with identical name and arguments
            const uniqueToolCalls: any[] = [];
            const seenKeys = new Set<string>();

            for (const tc of toolCalls) {
              if (tc && typeof tc === 'object') {
                let parsedArgs: any = {};
                try {
                  parsedArgs = JSON.parse(tc.arguments_json || '{}');
                } catch {
                  parsedArgs = { __malformed: tc.arguments_json };
                }

                // Auto-prepend plans directory for write_file and replace tools in Plan Mode to comply with policy constraints
                if (
                  (tc.name === 'write_file' || tc.name === 'replace') &&
                  this.currentPlansDir &&
                  parsedArgs.file_path &&
                  !parsedArgs.file_path.includes('.gemini')
                ) {
                  let cleanFile = parsedArgs.file_path.replace(/^[.\\/]+/, '');
                  if (cleanFile.startsWith('plans/')) {
                    cleanFile = cleanFile.slice(6);
                  } else if (cleanFile.startsWith('plans\\')) {
                    cleanFile = cleanFile.slice(6);
                  }
                  parsedArgs.file_path = `${this.currentPlansDir}/${cleanFile}`;
                }

                // Create a stable key for deduplication based on sorted arguments
                const stableArgs =
                  typeof parsedArgs === 'object' && parsedArgs !== null
                    ? JSON.stringify(
                        Object.keys(parsedArgs)
                          .sort()
                          .reduce((acc, key) => {
                            acc[key] = parsedArgs[key];
                            return acc;
                          }, {} as any),
                      )
                    : tc.arguments_json || '';
                const key = `${tc.name || ''}:${stableArgs}`;

                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  uniqueToolCalls.push({
                    tc,
                    parsedArgs,
                  });
                }
              }
            }

            emittedToolCallCount += uniqueToolCalls.length;
            uniqueToolCalls.forEach(({ tc, parsedArgs }) => {
              const baseId =
                currentToolUseId ||
                `call_${Math.random().toString(36).substring(2, 9)}`;
              const uniqueId = `${baseId}_${parts.filter((p) => p.functionCall).length}`;

              parts.push({
                functionCall: {
                  id: uniqueId,
                  name: tc.name,
                  args: parsedArgs,
                },
                metadata: { originalToolUseId: currentToolUseId },
              } as any);
            });
          }
        }
      }
    }

    const functionCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall);

    const bedrockTurnState: any = {
      isStreaming: false,
      rawStopReason: stopReason,
      responseText,
      emittedToolCallCount,
      stream: {
        sawAssistantText,
        sawContentBlockStop: true,
        sawToolUseStart: true,
        sawToolUseDelta: true,
        sawToolUseComplete: true,
        emittedAssistantTextBlockCount: sawAssistantText ? 1 : 0,
        emittedToolCallCount,
      },
    };

    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts,
          },
          finishReason:
            stopReason === 'end_turn' ? 'STOP' : stopReason.toUpperCase(),
        },
      ],
      functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
      usageMetadata: {
        promptTokenCount: response.usage?.inputTokens || 0,
        candidatesTokenCount: response.usage?.outputTokens || 0,
        totalTokenCount:
          (response.usage?.inputTokens || 0) +
          (response.usage?.outputTokens || 0),
      },
      metadata: {
        bedrockTurnState,
      },
    } as any as GenerateContentResponse;
  }

  private async *mapStreamResponse(
    stream: any,
    requestId?: string,
  ): AsyncGenerator<GenerateContentResponse> {
    let currentBlockJson = '';
    let lastYieldedThoughts = '';
    let lastYieldedText = '';
    let currentToolUseId = '';

    let sawAssistantText = false;
    let sawToolUseStart = false;
    let sawToolUseDelta = false;
    let emittedAssistantTextBlockCount = 0;

    const allTextParts: string[] = [];
    const allThoughtParts: string[] = [];
    const allFunctionCalls: any[] = [];

    for await (const chunk of stream) {
      if (chunk.contentBlockStart?.start?.toolUse) {
        currentToolUseId =
          chunk.contentBlockStart.start.toolUse.toolUseId || '';
        currentBlockJson = '';
        if (
          chunk.contentBlockStart.start.toolUse.name === 'nova_response_schema'
        ) {
          sawToolUseStart = true;
        }
      }

      if (chunk.contentBlockDelta?.delta?.toolUse) {
        sawToolUseDelta = true;
        const deltaInput = chunk.contentBlockDelta.delta.toolUse.input || '';
        currentBlockJson += deltaInput;

        const parsed = parsePartialResponse(currentBlockJson);

        const currentTotalThoughts = [...allThoughtParts, parsed.thoughts].join(
          '\n',
        );
        if (
          currentTotalThoughts &&
          currentTotalThoughts !== lastYieldedThoughts
        ) {
          const deltaThoughts = currentTotalThoughts.slice(
            lastYieldedThoughts.length,
          );
          if (deltaThoughts) {
            lastYieldedThoughts = currentTotalThoughts;
            yield {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: deltaThoughts, thought: true }],
                  },
                },
              ],
              responseId: requestId,
            } as any as GenerateContentResponse;
          }
        }

        const currentTotalText = [...allTextParts, parsed.text].join('');
        if (currentTotalText && currentTotalText !== lastYieldedText) {
          const deltaText = currentTotalText.slice(lastYieldedText.length);
          if (deltaText) {
            lastYieldedText = currentTotalText;
            sawAssistantText = true;
            emittedAssistantTextBlockCount++;

            const loopCheck = detectMonologueRepetition(currentTotalText);
            if (loopCheck.isLoop) {
              ProviderLogger.log(
                this.logFilename,
                'ERROR',
                `Loop detected! Breaking stream: ${loopCheck.reason}`,
              );
              break;
            }

            yield {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: deltaText }],
                  },
                },
              ],
              responseId: requestId,
            } as any as GenerateContentResponse;
          }
        }
      }

      if (chunk.contentBlockStop) {
        let finalThoughts = '';
        let finalText = '';
        let finalToolCalls: any[] = [];

        try {
          const parsedFinal = JSON.parse(currentBlockJson || '{}');
          finalThoughts = parsedFinal.thoughts || '';
          finalText = parsedFinal.text || '';

          // CRITICAL FIX: Strictly validate that tool_calls is an array
          const rawToolCalls = parsedFinal.tool_calls;
          finalToolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
        } catch {
          const parsedPartial = parsePartialResponse(currentBlockJson);
          finalThoughts = parsedPartial.thoughts;
          finalText = parsedPartial.text;
          finalToolCalls = [];
        }

        if (finalThoughts) allThoughtParts.push(finalThoughts);
        if (finalText) allTextParts.push(finalText);

        const uniqueToolCalls: any[] = [];
        if (Array.isArray(finalToolCalls)) {
          const seenKeys = new Set<string>();
          for (const tc of finalToolCalls) {
            if (tc && typeof tc === 'object') {
              let parsedArgs: any = {};
              try {
                parsedArgs = JSON.parse(tc.arguments_json || '{}');
              } catch {
                parsedArgs = { __malformed: tc.arguments_json };
              }

              // Auto-prepend plans directory for write_file and replace tools in Plan Mode to comply with policy constraints
              if (
                (tc.name === 'write_file' || tc.name === 'replace') &&
                this.currentPlansDir &&
                parsedArgs.file_path &&
                !parsedArgs.file_path.includes('.gemini')
              ) {
                let cleanFile = parsedArgs.file_path.replace(/^[.\\/]+/, '');
                if (cleanFile.startsWith('plans/')) {
                  cleanFile = cleanFile.slice(6);
                } else if (cleanFile.startsWith('plans\\')) {
                  cleanFile = cleanFile.slice(6);
                }
                parsedArgs.file_path = `${this.currentPlansDir}/${cleanFile}`;
              }

              // Create a stable key for deduplication based on sorted arguments
              const stableArgs =
                typeof parsedArgs === 'object' && parsedArgs !== null
                  ? JSON.stringify(
                      Object.keys(parsedArgs)
                        .sort()
                        .reduce((acc, key) => {
                          acc[key] = parsedArgs[key];
                          return acc;
                        }, {} as any),
                    )
                  : tc.arguments_json || '';
              const key = `${tc.name || ''}:${stableArgs}`;

              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                uniqueToolCalls.push({
                  tc,
                  parsedArgs,
                });
              }
            }
          }
        }

        uniqueToolCalls.forEach(({ tc, parsedArgs }) => {
          const baseId =
            currentToolUseId ||
            `call_${Math.random().toString(36).substring(2, 9)}`;
          const uniqueId = `${baseId}_${allFunctionCalls.length}`;
          allFunctionCalls.push({
            id: uniqueId,
            name: tc.name,
            args: parsedArgs,
            originalId: currentToolUseId,
          });
        });
      }

      if (chunk.messageStop) {
        const stopReason = chunk.messageStop.stopReason || 'stop';
        const emittedToolCallCount = allFunctionCalls.length;

        const bedrockTurnState: any = {
          isStreaming: true,
          rawStopReason: stopReason,
          responseText: allTextParts.join('').trim(),
          emittedToolCallCount,
          stream: {
            sawAssistantText,
            sawContentBlockStop: true,
            sawToolUseStart,
            sawToolUseDelta,
            sawToolUseComplete: true,
            emittedAssistantTextBlockCount,
            emittedToolCallCount,
          },
        };

        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: allFunctionCalls.map(
                  (fc) =>
                    ({
                      functionCall: {
                        id: fc.id,
                        name: fc.name,
                        args: fc.args,
                      },
                      metadata: { originalToolUseId: fc.originalId },
                    }) as any,
                ),
              },
              finishReason:
                stopReason === 'end_turn' ? 'STOP' : stopReason.toUpperCase(),
            },
          ],
          functionCalls: allFunctionCalls.map((fc) => ({
            id: fc.id,
            name: fc.name,
            args: fc.args,
          })),
          metadata: {
            bedrockTurnState,
          },
          responseId: requestId,
        } as any as GenerateContentResponse;
      }

      if (chunk.metadata) {
        yield {
          usageMetadata: {
            promptTokenCount: chunk.metadata.usage?.inputTokens || 0,
            candidatesTokenCount: chunk.metadata.usage?.outputTokens || 0,
            totalTokenCount:
              (chunk.metadata.usage?.inputTokens || 0) +
              (chunk.metadata.usage?.outputTokens || 0),
          },
          responseId: requestId,
        } as any as GenerateContentResponse;
      }
    }
  }

  private appendToolSchemaHint(
    system: SystemContentBlock[],
    tools: any,
  ): SystemContentBlock[] {
    if (!tools || tools.length === 0) return system;

    const declarations: any[] = [];
    for (const t of tools) {
      if (t && Array.isArray(t.functionDeclarations)) {
        declarations.push(...t.functionDeclarations);
      } else if (t) {
        declarations.push(t);
      }
    }

    if (declarations.length === 0) return system;

    const schemaHint = `
============================================================
AVAILABLE WORKSPACE TOOLS (STRICT SCHEMA)
============================================================
You have access to the following workspace tools. You MUST follow the parameter names and structures exactly.
Hallucinating parameter names (e.g., using "path" instead of "file_path") is a violation of your mandates.

${declarations
  .map((spec: any) => {
    // CRITICAL FIX: Read parametersJsonSchema if parameters is empty (standard in Gemini CLI tool registry)
    const params = spec.parametersJsonSchema || spec.parameters || {};
    const required = params.required || [];
    const props = params.properties || {};
    return `- Tool Name: ${spec.name}\n  Description: ${spec.description}\n  Required Parameters: [${required.join(', ')}]\n  Full Parameter Schema: ${JSON.stringify(props)}`;
  })
  .join('\n\n')}

FORMAT RULES FOR USING TOOLS:
1. If you need to invoke a tool, add an object to the \"tool_calls\" array containing \"name\" (the tool name) and \"arguments_json\" (stringified JSON arguments object matching the schema).
2. If no tools are required, leave the \"tool_calls\" array empty [].
============================================================
`;
    // Bedrock Converse API ONLY supports exactly one system block. Merge if needed.
    const baseText = system.map((s) => s.text || '').join('\n');
    return [{ text: baseText + '\n' + schemaHint }];
  }

  private enhanceBedrockSystemPrompt(
    system: SystemContentBlock[],
  ): SystemContentBlock[] {
    const rules = `
[CRITICAL BEHAVIORAL RULE FOR BEDROCK NOVA]
- You are prone to repeating yourself in internal monologues (e.g. "Let me check...", "Actually, let me...", "But first, let me check..."). This is strictly forbidden.
- NEVER generate planning thoughts that begin with "Let me", "Actually", "Next, I will", "But first", or "I think".
- If you need to search or read a file, execute the tool call directly. Do not announce it, do not plan it, and do not debate it.
- DO NOT output any user-visible text or thought blocks before a tool call. If you decide to call a tool, your entire output for that chunk must be ONLY the tool call itself.
- If you find yourself repeating the same thoughts or actions, STOP immediately and ask the user a direct question instead of looping.
- **update_topic Mandate**: When calling the "update_topic" tool, you MUST ALWAYS provide the "strategic_intent" parameter (a single sentence explaining your immediate tactical goal) in addition to "title" and "summary". If you omit "strategic_intent", the tool call will fail and trigger a loop error.`;

    if (system.length === 0) return [{ text: rules }];
    // Merge into the first block to maintain single-block constraint
    return [{ text: system[0].text + '\n' + rules }];
  }
}

export function parsePartialResponse(json: string): {
  thoughts: string;
  text: string;
} {
  let thoughts = '';
  let text = '';
  const thoughtsMatch = /\"thoughts\"\s*:\s*\"((?:[^\"\\]|\\.)*)/.exec(json);
  if (thoughtsMatch) {
    thoughts = unescapePartialString(thoughtsMatch[1]);
  }
  const textMatch = /\"text\"\s*:\s*\"((?:[^\"\\]|\\.)*)/.exec(json);
  if (textMatch) {
    text = unescapePartialString(textMatch[1]);
  }
  return { thoughts, text };
}

export function unescapePartialString(s: string): string {
  try {
    let clean = s;
    if (clean.endsWith('\\')) {
      clean = clean.slice(0, -1);
    }
    return JSON.parse('\"' + clean + '\"');
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\"/g, '\"').replace(/\\\\/g, '\\');
  }
}

export function cleanToolCallId(id: string): string {
  if (!id) return id;
  const lastDoubleUnderscore = id.lastIndexOf('__');
  let cleanId =
    lastDoubleUnderscore !== -1 ? id.substring(lastDoubleUnderscore + 2) : id;

  const lastUnderscore = cleanId.lastIndexOf('_');
  if (
    lastUnderscore !== -1 &&
    !isNaN(Number(cleanId.substring(lastUnderscore + 1)))
  ) {
    cleanId = cleanId.substring(0, lastUnderscore);
  }
  return cleanId;
}

export function mergeToolResultTexts(text1: string, text2: string): string {
  try {
    const p1 = JSON.parse(text1);
    const p2 = JSON.parse(text2);
    const arr1 = Array.isArray(p1) ? p1 : [p1];
    const arr2 = Array.isArray(p2) ? p2 : [p2];
    return JSON.stringify([...arr1, ...arr2]);
  } catch {
    if (!text1) return text2;
    if (!text2) return text1;
    return JSON.stringify({ success: true, details: `${text1}; ${text2}` });
  }
}
