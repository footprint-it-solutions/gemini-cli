/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { 
  Config, 
  LegacyAgentSession, 
  Scheduler, 
  ROOT_SCHEDULER_ID,
  getAuthTypeFromEnv,
  AuthType,
  OutputFormat,
} from '@google/gemini-cli-core';

export interface GeminiSessionOptions {
  taskID: string;
  persona: string;
  logLevel: string;
  slackChannel?: string;
  slackThreadTS?: string;
  inlineThinkingMode?: string;
  sessionID?: string;
  model?: string;
}

export class GeminiSession extends EventEmitter {
  private config: Config;
  private scheduler: Scheduler;
  private session: LegacyAgentSession;

  constructor(options: GeminiSessionOptions) {
    super();
    
    const cwd = process.cwd();
    this.config = new Config({
      sessionId: options.taskID,
      targetDir: cwd,
      cwd,
      debugMode: options.logLevel === 'debug',
      model: options.model || process.env['GEMINI_MODEL'] || '',
      output: { format: OutputFormat.STREAM_JSON },
    });

    this.scheduler = new Scheduler({
      context: this.config,
      messageBus: this.config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    this.session = new LegacyAgentSession({
      client: this.config.getGeminiClient(),
      scheduler: this.scheduler,
      config: this.config,
      promptId: options.taskID,
    });
  }

  async execute(prompt: string): Promise<void> {
    const authType =
      getAuthTypeFromEnv(this.config.getActiveModel()) || AuthType.BEDROCK;
    await this.config.refreshAuth(authType);
    await this.config.initialize();

    const { streamId } = await this.session.send({
      message: {
        content: [{ type: 'text', text: prompt }],
        displayContent: prompt,
      },
    });

    if (!streamId) {
      throw new Error('Failed to start stream');
    }

    for await (const event of this.session.stream({ streamId })) {
      this.emit('event', event);
    }
  }
}
