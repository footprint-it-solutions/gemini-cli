/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenAIContentGenerator } from './openAiProvider.js';

export class OllamaContentGenerator extends OpenAIContentGenerator {
  constructor(baseURL?: string) {
    // Ollama typically doesn't need an API key, but the OpenAI client requires one.
    // Use 'ollama' as a placeholder.
    super('ollama', baseURL || 'http://localhost:11434/v1');
  }
}
