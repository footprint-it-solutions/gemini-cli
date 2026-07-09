/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tokenLimit, DEFAULT_TOKEN_LIMIT } from './tokenLimits.js';
import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
} from '../config/models.js';

describe('tokenLimit', () => {
  it('should return the correct token limit for default models', () => {
    expect(tokenLimit(DEFAULT_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_LITE_MODEL)).toBe(1_048_576);
  });

  it('should return the correct token limit for preview models', () => {
    expect(tokenLimit(PREVIEW_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(PREVIEW_GEMINI_FLASH_MODEL)).toBe(1_048_576);
  });

  it('should return the correct token limit for gemma 4 local and remote vllm models', () => {
    expect(tokenLimit('gemma4-12b')).toBe(32_768);
    expect(tokenLimit('vllm/google/gemma-4-12B-it-qat-q4_0-unquantized')).toBe(
      32_768,
    );
    expect(tokenLimit('gemma4-12b-remote')).toBe(98_304);
    expect(
      tokenLimit('vllm/google/gemma-4-12B-it-qat-q4_0-unquantized-remote'),
    ).toBe(98_304);
  });

  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return the default token limit if no model is provided', () => {
    // @ts-expect-error testing invalid input
    expect(tokenLimit(undefined)).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should have the correct default token limit value', () => {
    expect(DEFAULT_TOKEN_LIMIT).toBe(1_048_576);
  });
});
