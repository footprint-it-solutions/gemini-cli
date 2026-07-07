/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OllamaContentGenerator } from './ollamaProvider.js';
import type { CountTokensParameters } from '@google/genai';

describe('OllamaContentGenerator', () => {
  let generator: OllamaContentGenerator;

  beforeEach(() => {
    generator = new OllamaContentGenerator();
  });

  describe('countTokens', () => {
    it('should handle string content input', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: 'Hello world',
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle array of string content', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: ['Hello', 'world'],
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle Content object with text property', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: {
          role: 'user',
          parts: [{ text: 'Hello world' }],
        },
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle array of Content objects', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
          {
            role: 'model',
            parts: [{ text: 'world' }],
          },
        ],
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle mixed content types', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          'Hello',
          {
            role: 'user',
            parts: [{ text: 'world' }],
          } as any,
        ],
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle ollama/ prefixed model names', async () => {
      const request: CountTokensParameters = {
        model: 'ollama/test-model',
        contents: 'Hello world',
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle empty content', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: '',
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });

    it('should handle null content gracefully', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: null as any,
      };

      const result = await generator.countTokens(request);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalTokens');
      expect(typeof result.totalTokens).toBe('number');
    });
  });
});
