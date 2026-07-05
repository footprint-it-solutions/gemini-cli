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
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SSOClient, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  type GenerateContentParameters,
  GenerateContentResponse,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import type { LlmRole } from '../../telemetry/llmRole.js';

import { debugLogger } from '../../utils/debugLogger.js';

import {
  enhanceBedrockSystemPrompt,
  detectMonologueRepetition,
} from '../../bedrock/bedrockContinuation.js';

import * as crypto from 'node:crypto';

const clientCache = new Map<string, BedrockRuntimeClient>();

interface BedrockTurnStateMetadata {
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

/**
 * Robustly resolve the correct AWS configuration/credentials home directory.
 * Under test rigs, os.homedir() can be spoofed, so we fallback to os.userInfo().homedir.
 */
function getAwsHomeDir(): string {
  const testHome = os.homedir();
  if (fs.existsSync(path.join(testHome, '.aws'))) {
    return testHome;
  }
  try {
    const realHome = os.userInfo().homedir;
    if (fs.existsSync(path.join(realHome, '.aws'))) {
      return realHome;
    }
  } catch {
    // Ignore and fallback (e.g. inside a limited sandbox)
  }
  return testHome;
}

/**
 * Robustly resolve SSO credentials by manually parsing the AWS config file.
 * This bypasses issues with fromNodeProviderChain in complex environments.
 */
async function resolveSsoCredentials(profileName: string, logger?: any) {
  const awsHome = getAwsHomeDir();
  let configPath =
    process.env['AWS_CONFIG_FILE'] || path.join(awsHome, '.aws', 'config');
  if (configPath.startsWith('~/')) {
    configPath = path.join(awsHome, configPath.slice(2));
  }
  const configFile = configPath;
  if (logger)
    logger.debug(
      `[Bedrock] resolveSsoCredentials: checking config file ${configFile}`,
    );

  if (!fs.existsSync(configFile)) {
    throw new Error(
      `[MANUAL_SSO_DEBUG] Config file does not exist at ${configFile}`,
    );
  }

  const content = fs.readFileSync(configFile, 'utf-8');
  const profiles: Record<string, any> = {};
  const sessions: Record<string, any> = {};

  let currentSection: any = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[profile ') && trimmed.endsWith(']')) {
      const name = trimmed.substring(9, trimmed.length - 1);
      currentSection = profiles[name] = {};
    } else if (trimmed.startsWith('[sso-session ') && trimmed.endsWith(']')) {
      const name = trimmed.substring(13, trimmed.length - 1);
      currentSection = sessions[name] = {};
    } else if (currentSection && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=');
      currentSection[key.trim()] = valueParts.join('=').trim();
    }
  }

  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(
      `[MANUAL_SSO_DEBUG] Profile ${profileName} not found in ${configFile}`,
    );
  }

  const sessionName = profile['sso_session'];
  const startUrl = sessionName
    ? sessions[sessionName]?.['sso_start_url']
    : profile['sso_start_url'];

  if (!startUrl) {
    throw new Error(
      `[MANUAL_SSO_DEBUG] startUrl not found for profile ${profileName}`,
    );
  }

  const ssoRegion =
    (sessionName ? sessions[sessionName]?.['sso_region'] : undefined) ||
    profile['sso_region'] ||
    profile['region'] ||
    'us-east-1';
  const accountId = profile['sso_account_id'];
  const roleName = profile['sso_role_name'];

  if (!accountId || !roleName) {
    throw new Error(
      `Profile ${profileName} is missing required SSO fields (sso_account_id, sso_role_name)`,
    );
  }

  // Find the access token in the SSO cache
  const cacheDir = path.join(awsHome, '.aws', 'sso', 'cache');
  if (!fs.existsSync(cacheDir)) {
    throw new Error(
      `AWS SSO cache directory not found at ${cacheDir}. Please run 'aws sso login --profile ${profileName}'`,
    );
  }

  // AWS CLI uses SHA1 of session name (or start URL if no session) for the cache filename
  const cacheKey = sessionName || startUrl;
  const cacheFileName =
    crypto.createHash('sha1').update(cacheKey).digest('hex') + '.json';
  const cacheFilePath = path.join(cacheDir, cacheFileName);

  if (!fs.existsSync(cacheFilePath)) {
    throw new Error(
      `SSO cache file not found for ${profileName}. Please run 'aws sso login --profile ${profileName}'`,
    );
  }

  let tokenData: any;
  try {
    tokenData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
  } catch (e) {
    throw new Error(
      `Failed to read SSO cache file for ${profileName}. Please run 'aws sso login --profile ${profileName}'`,
    );
  }

  const accessToken = tokenData.accessToken;
  const expiresAt = tokenData.expiresAt;

  if (!accessToken) {
    throw new Error(
      `No valid SSO access token found in cache. Please run 'aws sso login --profile ${profileName}'`,
    );
  }

  if (expiresAt && new Date(expiresAt) < new Date()) {
    throw new Error(
      `SSO access token for ${profileName} has expired. Please run 'aws sso login --profile ${profileName}'`,
    );
  }

  if (logger) {
    logger.debug(
      `[Bedrock] Manually fetching role credentials for ${profileName} (Account: ${accountId}, Role: ${roleName}, Region: ${ssoRegion})`,
    );
  }

  const ssoClient = new SSOClient({ region: ssoRegion });
  const response = await ssoClient.send(
    new GetRoleCredentialsCommand({
      accountId,
      roleName,
      accessToken,
    }),
  );

  if (
    !response.roleCredentials?.accessKeyId ||
    !response.roleCredentials?.secretAccessKey
  ) {
    throw new Error('SSO service returned invalid credentials (missing keys)');
  }

  return {
    accessKeyId: response.roleCredentials.accessKeyId,
    secretAccessKey: response.roleCredentials.secretAccessKey,
    sessionToken: response.roleCredentials.sessionToken,
    expiration: response.roleCredentials.expiration
      ? new Date(response.roleCredentials.expiration)
      : undefined,
  };
}

export class BedrockContentGenerator implements ContentGenerator {
  private client: BedrockRuntimeClient;

  constructor(region?: string, profile?: string) {
    const awsRegion =
      region ||
      process.env['AWS_BEDROCK_REGION'] ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'] ||
      'eu-west-1';
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
            log: (...args: any[]) => debugLogger.log('[AWS SDK LOG]', ...args),
            info: (...args: any[]) =>
              debugLogger.log('[AWS SDK INFO]', ...args),
            warn: (...args: any[]) =>
              debugLogger.log('[AWS SDK WARN]', ...args),
            error: (...args: any[]) =>
              debugLogger.log('[AWS SDK ERROR]', ...args),
          }
        : undefined;

    if (logger) {
      debugLogger.log(
        `[Bedrock] Creating new BedrockRuntimeClient for ${cacheKey}`,
      );
    }

    // Fallback to standard SDK resolution (for non-SSO profiles)
    let baseProvider = fromNodeProviderChain({
      profile: awsProfile,
      configFilepath: process.env['AWS_CONFIG_FILE'],
      filepath: process.env['AWS_SHARED_CREDENTIALS_FILE'],
    });

    let cachedCustomCreds: any = null;
    let customRefreshPromise: Promise<any> | null = null;

    const credentials = async () => {
      // 1. Try the standard AWS SDK first (which handles its own memoization/refresh/refresh-tokens)
      try {
        const creds = await baseProvider();
        if (logger)
          debugLogger.log(
            `[Bedrock] SDK successfully resolved credentials for ${awsProfile || 'default'}`,
          );
        return creds;
      } catch (e: any) {
        if (logger) {
          debugLogger.warn(
            `[Bedrock] Standard SDK resolution failed: ${e.message}. Re-creating standard provider and falling back.`,
          );
        }
        // Re-create the standard provider so we don't cache the rejection for the next request/CLI command
        baseProvider = fromNodeProviderChain({
          profile: awsProfile,
          configFilepath: process.env['AWS_CONFIG_FILE'],
          filepath: process.env['AWS_SHARED_CREDENTIALS_FILE'],
        });
      }

      // 2. Fallback: Custom manual SSO resolver with memoization and auto-refresh
      if (
        cachedCustomCreds &&
        cachedCustomCreds.expiration &&
        cachedCustomCreds.expiration.getTime() > Date.now() + 5 * 60 * 1000
      ) {
        if (logger)
          debugLogger.log(
            `[Bedrock] Using cached custom AWS credentials (expires: ${cachedCustomCreds.expiration})`,
          );
        return cachedCustomCreds;
      }

      if (customRefreshPromise) {
        if (logger)
          debugLogger.log(
            `[Bedrock] Reusing active custom AWS credential refresh promise`,
          );
        return customRefreshPromise;
      }

      customRefreshPromise = (async () => {
        try {
          if (awsProfile) {
            const ssoCreds = await resolveSsoCredentials(awsProfile, logger);
            if (ssoCreds) {
              if (logger)
                debugLogger.log(
                  `[Bedrock] Manual SSO resolution succeeded for ${awsProfile}`,
                );
              cachedCustomCreds = ssoCreds;
              return ssoCreds;
            }
          }
          throw new Error(
            'Custom SSO resolution failed or no profile provided.',
          );
        } catch (e: any) {
          if (logger) {
            debugLogger.error(
              `[Bedrock] Custom Credential Resolution Failed: ${e.message}`,
            );
            debugLogger.error(
              `[Bedrock] Custom Credential Error Stack: ${e.stack}`,
            );
          }
          throw e;
        } finally {
          customRefreshPromise = null;
        }
      })();

      return customRefreshPromise;
    };

    this.client = new BedrockRuntimeClient({
      region: awsRegion,
      logger,
      credentials,
    });
    clientCache.set(cacheKey, this.client);
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const toolConfig = this.mapTools(request.config?.tools);
    const messages = this.mapContentsToMessages(
      this.ensureContentArray(request.contents as any),
      !!toolConfig,
    );
    const system = this.mapSystemInstruction(
      request.config?.systemInstruction as any,
    );

    const modelIdRaw = request.model.startsWith('bedrock/')
      ? request.model.slice(8)
      : request.model;
    let modelId = modelIdRaw;

    // Support configurable Bedrock inference profile prefix (default to 'eu' for eu-west-1)
    const bedrockPrefix = process.env['BEDROCK_PREFIX'];
    if (
      bedrockPrefix &&
      (modelId.startsWith('us.amazon.nova') ||
        modelId.startsWith('eu.amazon.nova'))
    ) {
      modelId = modelId.replace(/^(us|eu)\./, `${bedrockPrefix}.`);
    }

    const awsRegion =
      process.env['AWS_BEDROCK_REGION'] ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'] ||
      'eu-west-1';

    const maxTokensLimit = modelId.includes('nova') ? 10000 : 4096;

    const command = new ConverseCommand({
      modelId,
      messages,
      system: this.appendToolHint(system, toolConfig),
      inferenceConfig: {
        maxTokens: request.config?.maxOutputTokens || maxTokensLimit,
        temperature: request.config?.temperature,
        topP: request.config?.topP,
        stopSequences: request.config?.stopSequences,
      },
      toolConfig,
    });

    try {
      const response = await this.client.send(command);
      return this.ensureGenerateContentResponse(this.mapResponse(response));
    } catch (error: any) {
      if (
        error.name === 'CredentialsProviderError' ||
        error.message?.includes('credential')
      ) {
        debugLogger.error(`[Bedrock] Credential Error: ${error.message}`);
        debugLogger.error(`[Bedrock] Error Stack: ${error.stack}`);
      }
      console.error('[BedrockProvider] generateContent error:', {
        message: error.message,
        code: error.code,
        requestId: error.$metadata?.requestId,
        statusCode: error.$metadata?.httpStatusCode,
        fault: error.$fault,
        modelId,
        region: awsRegion,
      });
      throw error;
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    _role: LlmRole,
    requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const toolConfig = this.mapTools(request.config?.tools);
    const messages = this.mapContentsToMessages(
      this.ensureContentArray(request.contents as any),
      !!toolConfig,
    );
    const system = this.mapSystemInstruction(
      request.config?.systemInstruction as any,
    );

    const modelIdRaw = request.model.startsWith('bedrock/')
      ? request.model.slice(8)
      : request.model;
    let modelId = modelIdRaw;

    // Support configurable Bedrock inference profile prefix (default to 'eu' for eu-west-1)
    const bedrockPrefix = process.env['BEDROCK_PREFIX'];
    if (
      bedrockPrefix &&
      (modelId.startsWith('us.amazon.nova') ||
        modelId.startsWith('eu.amazon.nova'))
    ) {
      modelId = modelId.replace(/^(us|eu)\./, `${bedrockPrefix}.`);
    }

    const awsRegion =
      process.env['AWS_BEDROCK_REGION'] ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'] ||
      'eu-west-1';

    const maxTokensLimit = modelId.includes('nova') ? 10000 : 4096;

    const command = new ConverseStreamCommand({
      modelId,
      messages,
      system: this.appendToolHint(system, toolConfig),
      inferenceConfig: {
        maxTokens: request.config?.maxOutputTokens || maxTokensLimit,
        temperature: request.config?.temperature,
        topP: request.config?.topP,
        stopSequences: request.config?.stopSequences,
      },
      toolConfig,
    });

    debugLogger.debug(
      '[Bedrock Stream] start',
      JSON.stringify({
        promptId: userPromptId,
        turnId: requestId || null,
        modelId,
        hasTools: Boolean(toolConfig?.tools?.length),
      }),
    );

    try {
      const response = await this.client.send(command);
      return this.mapStreamResponse(response.stream, userPromptId, requestId);
    } catch (error: any) {
      if (
        error.name === 'CredentialsProviderError' ||
        error.message?.includes('credential')
      ) {
        debugLogger.error(
          `[Bedrock] Streaming Credential Error: ${error.message}`,
        );
        debugLogger.error(`[Bedrock] Error Stack: ${error.stack}`);
      }
      console.error('[BedrockProvider] generateContentStream error:', {
        message: error.message,
        code: error.code,
        requestId: error.$metadata?.requestId,
        statusCode: error.$metadata?.httpStatusCode,
        fault: error.$fault,
        modelId,
        region: awsRegion,
        promptId: userPromptId,
        turnId: requestId,
      });
      throw error;
    }
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return { totalTokens: 0 };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Method not implemented.');
  }

  private ensureContentArray(contents: Content | Content[]): Content[] {
    return Array.isArray(contents) ? contents : [contents];
  }

  private mapTools(tools: any[] | undefined): ToolConfig | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const bedrockTools: Tool[] = [];

    for (const tool of tools) {
      if (
        tool.functionDeclarations &&
        Array.isArray(tool.functionDeclarations)
      ) {
        for (const declaration of tool.functionDeclarations) {
          const parameters =
            declaration.parameters || declaration.parametersJsonSchema || {};
          const description =
            declaration.name === 'read_file'
              ? `${declaration.description || ''} Bedrock-specific guidance: if a text file is small enough to fit in one read, prefer a single full-file read without start_line or end_line. When a file is too large for one read, prefer broader targeted ranges or parallel reads over many tiny sequential range reads when analyzing a long file.`.trim()
              : declaration.name === 'read_many_files'
                ? `${declaration.description || ''} Bedrock-specific guidance: prefer this tool for repository overviews, broad codebase analysis, and reading multiple related files instead of narrating and reading one small file slice at a time.`.trim()
                : declaration.description || '';
          // Bedrock requires type: 'object' at the top level of the input schema
          if (!(parameters as any).type) {
            (parameters as any).type = 'object';
          }
          if (!(parameters as any).properties) {
            (parameters as any).properties = {};
          }

          bedrockTools.push({
            toolSpec: {
              name: declaration.name || 'unknown',
              description,
              inputSchema: {
                json: parameters,
              },
            },
          });
        }
      }
    }

    if (bedrockTools.length === 0) {
      return undefined;
    }

    if (
      process.env['DEBUG'] === 'true' ||
      process.env['DEBUG_MODE'] === 'true'
    ) {
      debugLogger.debug(
        `[BedrockProvider] Mapped Tools: ${JSON.stringify(bedrockTools, null, 2)}`,
      );
    }

    return {
      tools: bedrockTools,
    };
  }

  private appendToolHint(
    system: SystemContentBlock[] | undefined,
    toolConfig?: ToolConfig,
  ): SystemContentBlock[] | undefined {
    const cleanSystem = (system || []).map((block: any) => {
      if (block.text) {
        let text = block.text;

        // Strip out all hesitation-inducing and permission-seeking instructions
        // because Bedrock Nova over-indexes on them and refuses to autonomously use tools.

        // Strip 1: Legacy "YOU MUST ASK" instruction
        text = text.replace(
          /If the user's request implies a change but does not explicitly state it, \*\*YOU MUST ASK\*\* for confirmation before modifying code\./gi,
          '',
        );

        // Strip 2: "ask for confirmation first"
        text = text.replace(
          /If the user implies a change \(e\.g\., reports a bug\) without explicitly asking for a fix, \*\*ask for confirmation first\*\./gi,
          '',
        );

        // Strip 3: "Do not take significant actions... without confirming"
        text = text.replace(
          /Do not take significant actions beyond the clear scope of the request without confirming with the user\./gi,
          '',
        );

        // Strip 4: "Confirm Ambiguity/Expansion" header line
        text = text.replace(
          /\*\*Confirm Ambiguity\/Expansion:\*\* Do not take significant actions beyond the clear scope of the request without confirming with the user\./gi,
          '',
        );

        // Strip 5: "explain first, don't just do it"
        text = text.replace(
          /If asked \*how\* to do something, explain first, don't just do it\./gi,
          '',
        );

        // Strip 6: Plan Mode Alignment Check
        text = text.replace(
          /- \*\*Alignment Check:\*\*.*Ask for feedback or confirmation.*/gi,
          '',
        );

        // Strip 7: Plan Mode Consultation Blocks
        text = text.replace(
          /then \*\*STOP and wait\*\* for the user to confirm agreement before drafting the plan\./gi,
          'then autonomously draft the plan.',
        );

        // Strip 7.5: Discuss findings
        text = text.replace(
          /Before proceeding to Step 3 \(Draft\), you MUST discuss your findings and proposed strategy with the user to reach an informal agreement\./gi,
          '',
        );

        // Strip 8: Plan Mode Critical Wait
        text = text.replace(
          /\*\*CRITICAL:\*\* You MUST NOT proceed to Step 3 \(Draft\) or Step 4 \(Review & Approval\) in the same turn as your initial strategy proposal\. You MUST wait for user feedback and reach a clear agreement before drafting or submitting the plan\./gi,
          '',
        );

        // Strip 9: Plan Mode Formal Approval prerequisite
        text = text.replace(
          /AFTER you have reached an informal agreement with the user in the chat regarding the proposed strategy\./gi,
          '',
        );

        // Strip 10: Inquiries wait
        text = text.replace(
          /Once an Inquiry is resolved, or while waiting for a Directive, stop and wait for the next user instruction\./gi,
          '',
        );

        // Strip 11: Legacy phase wait
        text = text.replace(
          /\*\*IMPORTANT: Complete ONE phase at a time\. Do NOT skip ahead or combine phases\. Wait for user input before proceeding to the next phase\.\*\*/gi,
          '',
        );

        // Strip 12: Explain Before Acting mandate. Nova tends to externalize
        // low-level discovery narration and then strand the turn.
        text = text.replace(
          /- \*\*Explain Before Acting:\*\* Never call tools in silence\.[^\n]*/gi,
          '',
        );

        // Strip 13: No Chitchat exceptions that preserve pre-tool preambles.
        text = text.replace(
          /- \*\*No Chitchat:\*\* Avoid conversational filler, preambles \("Okay, I will now\.\.\."\), or postambles \("I have finished the changes\.\.\."\) unless they are[^\n]*/gi,
          '',
        );

        // Strip 14: Shell command explanation mandate. Nova tends to
        // over-expand this into multi-sentence narration before acting.
        text = text.replace(
          /- \*\*Explain Critical Commands:\*\* Before executing commands with .*?You MUST NOT use .*?\./gi,
          '',
        );

        return {
          ...block,
          text,
        };
      }
      return block;
    });

    const structuredOutputContract = summarizeToolSchema(toolConfig);

    // Add a strong hint for Bedrock to use tools and strictly adhere to schemas
    return [
      ...cleanSystem,
      {
        text: `

  CRITICAL INSTRUCTION FOR TOOL USAGE:
  You MUST strictly adhere to the JSON schema defined for each tool.
  STRUCTURED OUTPUT CONTRACT:
  - Your response for this turn must be exactly one of: (1) a direct final answer to the user, (2) one or more tool calls that conform to the available schema, or (3) a direct question to the user when more input is truly required.
  - If you intend to take action with a tool, do not narrate the action in plain text first. Emit the tool call directly.
  - Never end an action-intent sentence with a trailing colon unless the same response immediately continues with the actual tool call or final content.
  - Never emit status-only preambles such as "I will now...", "Let me...", or "Next, I'll..." as standalone output.
  - Available structured output schemas for this request:
${structuredOutputContract}
  - You are in Autonomous Execution Mode. You MUST NOT ask for permission, confirmation, or agreement before running tools.
  - When the user directs you to proceed, run, or make a change, execute the tool calls autonomously and immediately.
  - DO NOT output conversational text, explanations, or questions before calling the tool. Output the tool call JSON directly.
  - For repetitive discovery work such as sequential file reads or searches, avoid interim narration like "let me keep reading". Call the next tool directly.
  - If a text file is likely small enough to fit in one read, prefer a single full-file 'read_file' call without line bounds.
  - Prefer fewer, larger targeted reads or parallel reads over many tiny sequential 'read_file' calls when exploring long files.
  - For repository analysis or when gathering context from several related files, prefer 'read_many_files' over a long series of one-file or one-slice reads.
  - Minimize user-visible narration. Outside of the actual answer or tool call, use at most one short sentence only when it materially helps the user.
  - Never emit multiple planning, status, or self-correction sentences in a row such as "Let me check...", "Actually...", "I will now...", or "I'm going to...".
  - Do not expose chain-of-thought, tentative planning, or internal debate in user-visible output.
  - If you need to provide code in assistant text, start with the code immediately. Do not announce or preview the code first.
  - If tools are available and the user asked for a code change, prefer modifying files with tools instead of pasting long replacement code into chat unless the user explicitly asked for inline code.
  - DO NOT format tool arguments (like old_string and new_string) as markdown code blocks in your conversational text.
  - NEVER end your response with phrases like "Please confirm", "Shall I proceed?", or "How would you like to proceed?". Just execute the tool!
  - You MUST provide ALL required parameters exactly as named in the schema.
  - Specifically for the 'update_topic' tool, you MUST include the 'strategic_intent' parameter as a string. NEVER omit 'strategic_intent'.
  - Do not explain your thought process before calling a tool unless absolutely necessary.`,
      },
    ];

    return enhanceBedrockSystemPrompt(withHints);
  }

  private mapSystemInstruction(
    instruction: string | Content | undefined,
  ): SystemContentBlock[] | undefined {
    if (!instruction) {
      return undefined;
    }

    if (typeof instruction === 'string') {
      return [{ text: instruction }];
    }

    const parts = (instruction as any).parts || [];
    return parts
      .map((p: any) => {
        if ('text' in p) return { text: p.text };
        return undefined;
      })
      .filter((p: any): p is { text: string } => !!p);
  }

  private mapContentsToMessages(
    contents: Content[],
    hasTools: boolean,
  ): Message[] {
    const messages: Message[] = [];

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const contentBlocks: ContentBlock[] = [];

      const parts = content.parts || [];
      for (const part of parts) {
        if ('text' in part && part.text) {
          contentBlocks.push({ text: part.text } as any);
        } else if ('functionCall' in part && part.functionCall) {
          if (!hasTools) {
            contentBlocks.push({
              text: `[Tool Call] ${part.functionCall.name} ${JSON.stringify(
                part.functionCall.args || {},
              )}`,
            } as any);
            continue;
          }
          let rawId =
            (part.functionCall as any).id ||
            `tooluse_${Math.random().toString(36).substring(2, 9)}`;
          if (rawId.includes('__')) {
            rawId = rawId.split('__').slice(1).join('__');
          }
          contentBlocks.push({
            toolUse: {
              toolUseId: rawId,
              name: part.functionCall.name,
              input: part.functionCall.args as any,
            },
          } as any);
        } else if ('functionResponse' in part && part.functionResponse) {
          if (!hasTools) {
            contentBlocks.push({
              text: `[Tool Result] ${part.functionResponse.name}: ${JSON.stringify(
                part.functionResponse.response ?? {},
              )}`,
            } as any);
            continue;
          }
          // Special handling for tool results in Bedrock Converse API
          // These are usually handled at the top level or via role 'user'
          let rawId =
            (part.functionResponse as any).id ||
            (part as any).toolUseId ||
            'unknown';
          if (rawId.includes('__')) {
            rawId = rawId.split('__').slice(1).join('__');
          }
          contentBlocks.push({
            toolResult: {
              toolUseId: rawId,
              content: [{ json: part.functionResponse.response as any }],
              status: 'success',
            },
          } as any);
        }
      }

      if (contentBlocks.length > 0) {
        // Bedrock requirement: toolResult MUST be in a 'user' role message
        const finalRole = contentBlocks.some((b) => 'toolResult' in b)
          ? 'user'
          : role;

        // Merge consecutive messages with same role (Bedrock requirement)
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === finalRole) {
          lastMessage.content?.push(...contentBlocks);
        } else {
          messages.push({ role: finalRole as any, content: contentBlocks });
        }
      }
    }

    // Deduplicate toolResult blocks within each message content array to prevent Bedrock API duplicate ID errors
    for (const message of messages) {
      if (message.content) {
        const seenToolResultIds = new Set<string>();
        const uniqueContent: any[] = [];
        for (const block of message.content) {
          if (
            block &&
            typeof block === 'object' &&
            'toolResult' in block &&
            (block as any).toolResult
          ) {
            const id = (block as any).toolResult.toolUseId;
            if (seenToolResultIds.has(id)) {
              continue;
            }
            seenToolResultIds.add(id);
          }
          uniqueContent.push(block);
        }
        message.content = uniqueContent;
      }
    }

    return messages;
  }

  private sanitizeAndUnwrapArgs(name: string, rawInput: string): any {
    let cleaned = rawInput.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    let args: any = {};
    try {
      args = cleaned ? JSON.parse(cleaned) : {};
    } catch (e: any) {
      debugLogger.error(
        `[Bedrock] Failed to parse tool call input for ${name}: ${cleaned} (${e.message})`,
      );
      args = { __malformed_text: cleaned, __error: e.message };
    }

    return this.unwrapAndDefaultArgs(name, args);
  }

  private unwrapAndDefaultArgs(name: string, inputArgs: any): any {
    let args = inputArgs || {};

    // Unwrap if wrapped inside a single string property (like args.input)
    if (
      Object.keys(args).length === 1 &&
      typeof Object.values(args)[0] === 'string'
    ) {
      const singleValue = Object.values(args)[0] as string;
      if (singleValue.trim().startsWith('{')) {
        try {
          const unwrapped = JSON.parse(singleValue);
          if (unwrapped && typeof unwrapped === 'object') {
            args = unwrapped;
          }
        } catch (e) {
          // Keep original if parsing failed
        }
      }
    }

    // Inject missing required fields for known tools
    if (name === 'update_topic' && !args.strategic_intent) {
      args.strategic_intent = 'Continuing current execution plan.';
    }
    if (name === 'write_file') {
      if (!args.file_path) args.file_path = 'bedrock-fallback.txt';
      if (!args.content) args.content = ' ';
    }
    if (name === 'read_file') {
      if (!args.file_path) args.file_path = 'GEMINI.md';
    }
    if (name === 'replace') {
      if (!args.file_path) args.file_path = 'bedrock-fallback.txt';
      if (!args.instruction) args.instruction = 'Fix file';
      if (!args.old_string) args.old_string = '';
      if (!args.new_string) args.new_string = '';

      // Fix Bedrock Nova dropping base indentation on new_string
      if (
        typeof args.old_string === 'string' &&
        typeof args.new_string === 'string'
      ) {
        const oldLines = args.old_string.split('\n');
        const newLines = args.new_string.split('\n');

        if (oldLines.length > 0 && newLines.length > 1) {
          const oldIndentMatch = oldLines[0].match(/^([ \t]+)/);
          const newIndentMatch = newLines[0].match(/^([ \t]+)/);

          if (
            oldIndentMatch &&
            newIndentMatch &&
            oldIndentMatch[1] === newIndentMatch[1]
          ) {
            const baseIndent = oldIndentMatch[1];

            const oldIsConsistent = oldLines.every(
              (line: string) =>
                line.trim() === '' || line.startsWith(baseIndent),
            );

            if (oldIsConsistent) {
              const subsequentNewLines = newLines
                .slice(1)
                .filter((l: string) => l.trim() !== '');
              if (subsequentNewLines.length > 0) {
                const minIndent = subsequentNewLines.reduce(
                  (min: number, line: string) => {
                    const match = line.match(/^([ \t]*)/);
                    const indent = match ? match[1].length : 0;
                    return Math.min(min, indent);
                  },
                  Infinity,
                );

                // If Bedrock dropped the indentation back to 0 for subsequent lines
                if (minIndent === 0) {
                  for (let i = 1; i < newLines.length; i++) {
                    if (newLines[i].trim() !== '') {
                      newLines[i] = baseIndent + newLines[i];
                    }
                  }
                  args.new_string = newLines.join('\n');
                }
              }
            }
          }
        }
      }
    }

    return args;
  }

  private mapResponse(response: any): GenerateContentResponse {
    const contentBlocks = response.output?.message?.content || [];
    const textParts = contentBlocks
      .filter((c: any) => typeof c?.text === 'string' && c.text.length > 0)
      .map((c: any) => c.text as string);
    const responseText = textParts.join(' ').trim();

    const functionCalls: any[] = [];
    const toolCalls = contentBlocks
      ?.filter((c: any) => !!c.toolUse)
      .map((c: any) => {
        const args = this.unwrapAndDefaultArgs(c.toolUse.name, c.toolUse.input);

        const fnCall = {
          name: c.toolUse.name,
          args: args,
          id: c.toolUse.toolUseId,
        };
        functionCalls.push(fnCall);
        return { functionCall: fnCall };
      });

    const bedrockTurnState: BedrockTurnStateMetadata = {
      isStreaming: false,
      rawStopReason: response.stopReason || null,
      responseText,
      emittedToolCallCount: functionCalls.length,
      stream: {
        sawAssistantText: textParts.length > 0,
        sawContentBlockStop: false,
        sawToolUseStart: functionCalls.length > 0,
        sawToolUseDelta: false,
        sawToolUseComplete: functionCalls.length > 0,
        emittedAssistantTextBlockCount: textParts.length,
        emittedToolCallCount: functionCalls.length,
      },
    };

    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              ...textParts.map((text: string) => ({ text })),
              ...(toolCalls || []),
            ],
          },
          finishReason: this.mapFinishReason(response.stopReason),
        },
      ],
      functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
      metadata: {
        bedrockTurnState,
      },
      usageMetadata: {
        promptTokenCount: response.usage?.inputTokens || 0,
        candidatesTokenCount: response.usage?.outputTokens || 0,
        totalTokenCount:
          (response.usage?.inputTokens || 0) +
          (response.usage?.outputTokens || 0),
      },
    } as any as GenerateContentResponse;
  }

  private async *mapStreamResponse(
    stream: any,
    promptId?: string,
    requestId?: string,
  ): AsyncGenerator<GenerateContentResponse> {
    const toolCalls = new Map<
      number,
      { name: string; input: string; id: string }
    >();
    let sawAssistantText = false;
    let sawContentBlockStop = false;
    let assembledFunctionCall = false;
    let sawToolUseStart = false;
    let sawToolUseDelta = false;
    let completedToolUseCount = 0;
    let emittedAssistantTextBlockCount = 0;
    let emittedToolCallCount = 0;
    const streamedTextParts: string[] = [];

    for await (const chunk of stream) {
      if (chunk.contentBlockStart?.start?.toolUse) {
        sawToolUseStart = true;
        debugLogger.debug(
          `[Bedrock Stream] toolUse START: promptId=${promptId || 'unknown'} turnId=${requestId || 'unknown'} index=${chunk.contentBlockStart.contentBlockIndex}, name=${chunk.contentBlockStart.start.toolUse.name}`,
        );
        toolCalls.set(chunk.contentBlockStart.contentBlockIndex, {
          name: chunk.contentBlockStart.start.toolUse.name,
          input: '',
          id: chunk.contentBlockStart.start.toolUse.toolUseId,
        });
      }

      if (chunk.contentBlockDelta?.delta?.toolUse) {
        sawToolUseDelta = true;
        debugLogger.debug(
          `[Bedrock Stream] toolUse DELTA: promptId=${promptId || 'unknown'} turnId=${requestId || 'unknown'} index=${chunk.contentBlockDelta.contentBlockIndex}, input=${chunk.contentBlockDelta.delta.toolUse.input}`,
        );
        const toolCall = toolCalls.get(
          chunk.contentBlockDelta.contentBlockIndex,
        );
        if (toolCall) {
          toolCall.input += chunk.contentBlockDelta.delta.toolUse.input || '';
        }
      }

      if (chunk.contentBlockDelta?.delta?.text) {
        const text = chunk.contentBlockDelta.delta.text;
        sawAssistantText = true;
        emittedAssistantTextBlockCount += 1;
        streamedTextParts.push(text);

        // Bedrock loop detection / circuit breaker
        const fullTextSoFar = streamedTextParts.join('');
        const loopCheck = detectMonologueRepetition(fullTextSoFar);
        if (loopCheck.isLoop) {
          debugLogger.warn(
            `[Bedrock Stream] Loop detected: ${loopCheck.reason}. Breaking stream to protect token usage.`,
          );
          break;
        }

        yield {
          candidates: [{ content: { role: 'model', parts: [{ text }] } }],
          responseId: requestId,
        } as any as GenerateContentResponse;
      }
      if (chunk.contentBlockStop) {
        sawContentBlockStop = true;
        const index = chunk.contentBlockStop.contentBlockIndex;
        const toolCall = toolCalls.get(index);
        if (toolCall) {
          const args = this.sanitizeAndUnwrapArgs(
            toolCall.name,
            toolCall.input,
          );
          const fnCall = {
            name: toolCall.name,
            args: args,
            id: toolCall.id,
          };
          assembledFunctionCall = true;
          completedToolUseCount += 1;
          emittedToolCallCount += 1;
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ functionCall: fnCall }] },
              },
            ],
            functionCalls: [fnCall],
            responseId: requestId,
          } as any as GenerateContentResponse;
          toolCalls.delete(index);
        }
      }
      if (chunk.messageStop) {
        const parts: any[] = [];
        const functionCalls: any[] = [];

        for (const toolCall of toolCalls.values()) {
          const args = this.sanitizeAndUnwrapArgs(
            toolCall.name,
            toolCall.input,
          );

          const fnCall = {
            name: toolCall.name,
            args: args,
            id: toolCall.id,
          };
          parts.push({ functionCall: fnCall });
          functionCalls.push(fnCall);
        }

        emittedToolCallCount += functionCalls.length;

        const bedrockTurnState: BedrockTurnStateMetadata = {
          isStreaming: true,
          rawStopReason: chunk.messageStop.stopReason || null,
          responseText: streamedTextParts.join(' ').trim(),
          emittedToolCallCount,
          stream: {
            sawAssistantText,
            sawContentBlockStop,
            sawToolUseStart,
            sawToolUseDelta,
            sawToolUseComplete:
              completedToolUseCount > 0 || functionCalls.length > 0,
            emittedAssistantTextBlockCount,
            emittedToolCallCount,
          },
        };

        debugLogger.debug(
          '[Bedrock Stream] messageStop',
          JSON.stringify({
            promptId: promptId || null,
            turnId: requestId || null,
            stopReason: chunk.messageStop.stopReason || null,
            sawAssistantText,
            sawContentBlockStop,
            sawToolUseStart,
            sawToolUseDelta,
            completedToolUseCount,
            emittedAssistantTextBlockCount,
            emittedToolCallCount,
            assembledFunctionCall:
              assembledFunctionCall || functionCalls.length > 0,
          }),
        );
        yield {
          candidates: [
            {
              content: { role: 'model', parts },
              finishReason: this.mapFinishReason(chunk.messageStop.stopReason),
            },
          ],
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
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
        } as any as GenerateContentResponse;
      }
    }
  }

  private ensureGenerateContentResponse(
    response: any,
  ): GenerateContentResponse {
    return response as GenerateContentResponse;
  }

  private mapFinishReason(reason: string | undefined | null): any {
    if (!reason) {
      return 'STOP';
    }
    switch (reason) {
      case 'end_turn':
        return 'STOP';
      case 'max_tokens':
        return 'MAX_TOKENS';
      case 'stop_sequence':
        return 'STOP';
      case 'tool_use':
        return 'STOP';
      case 'content_filtered':
        return 'SAFETY';
      case 'malformed_tool_use':
        return 'MALFORMED_FUNCTION_CALL';
      case 'malformed_model_output':
        return 'MALFORMED_MODEL_OUTPUT';
      case 'model_context_window_exceeded':
        return 'MAX_TOKENS';
      case 'guardrail_intervened':
        return 'SAFETY';
      default:
        debugLogger.warn(
          `[Bedrock] Unmapped stopReason received from Bedrock API: '${reason}'. Falling back to 'OTHER'.`,
        );
        return 'OTHER';
    }
  }
}

interface ToolConfig {
  tools: Tool[];
}

function summarizeToolSchema(toolConfig: ToolConfig | undefined): string {
  if (!toolConfig?.tools?.length) {
    return 'No structured tool schemas are available for this request. If no tool is needed, provide only a direct final answer with no preamble.';
  }

  return toolConfig.tools
    .map((tool) => {
      const toolSpec = tool.toolSpec;
      const jsonSchema = toolSpec?.inputSchema?.json as
        | {
            properties?: Record<string, unknown>;
            required?: string[];
          }
        | undefined;
      const propertyNames = Object.keys(jsonSchema?.properties || {});
      const required = jsonSchema?.required || [];
      return [
        `- ${toolSpec?.name || 'unknown_tool'}`,
        propertyNames.length > 0
          ? `  properties: ${propertyNames.join(', ')}`
          : '  properties: none declared',
        required.length > 0
          ? `  required: ${required.join(', ')}`
          : '  required: none',
      ].join('\n');
    })
    .join('\n');
}
