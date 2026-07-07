/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolveCompressionModelConfigAlias } from './chatCompressionService.js';
import { AuthType } from '../core/contentGenerator.js';

describe('resolveCompressionModelConfigAlias with third-party providers', () => {
  it('should return the model itself directly for Ollama auth', () => {
    const model = 'ollama/llama3.1';
    expect(resolveCompressionModelConfigAlias(model, AuthType.OLLAMA)).toBe(
      model,
    );
  });

  it('should return the model itself directly for Ollama Streaming auth', () => {
    const model = 'ollama-stream/llama3.1';
    expect(
      resolveCompressionModelConfigAlias(model, AuthType.OLLAMA_STREAMING),
    ).toBe(model);
  });

  it('should return the model itself directly for OpenAI auth', () => {
    const model = 'openai/gpt-4o';
    expect(resolveCompressionModelConfigAlias(model, AuthType.OPENAI)).toBe(
      model,
    );
  });
});
