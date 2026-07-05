/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  detectMonologueRepetition,
  enhanceBedrockSystemPrompt,
} from './bedrockContinuation.js';

describe('detectMonologueRepetition', () => {
  it('should not flag empty or normal texts', () => {
    expect(detectMonologueRepetition('').isLoop).toBe(false);
    expect(
      detectMonologueRepetition(
        'I will now search for the configuration file and report back.',
      ).isLoop,
    ).toBe(false);
    expect(
      detectMonologueRepetition(
        'Let me know if you would like me to adjust the plan.',
      ).isLoop,
    ).toBe(false);
  });

  it('should flag excessive repetition of the same hesitation phrase', () => {
    const loop1 =
      'Actually, let me check the file. Actually, let me check line 36. Actually, let me check the diff.';
    const result1 = detectMonologueRepetition(loop1);
    expect(result1.isLoop).toBe(true);
    expect(result1.reason).toContain('Repetition of phrase "let me" detected');

    const loop2 =
      'Actually, I am planning. Actually, that is correct. Actually, let me think.';
    const result2 = detectMonologueRepetition(loop2);
    expect(result2.isLoop).toBe(true);
    expect(result2.reason).toContain(
      'Repetition of phrase "actually" detected',
    );
  });

  it('should flag high concentration of hesitation phrases in small texts', () => {
    const loopText =
      'I think I am going in circles here. Let me take a step back. Actually, let me think about how to proceed. But first...';
    const result = detectMonologueRepetition(loopText);
    expect(result.isLoop).toBe(true);
    expect(result.reason).toContain('High concentration of hesitation phrases');
  });
});

describe('enhanceBedrockSystemPrompt', () => {
  it('should append guidelines correctly', () => {
    const originalPrompt = [{ text: 'You are a helpful assistant.' }];
    const enhanced = enhanceBedrockSystemPrompt(originalPrompt);
    expect(enhanced).toHaveLength(2);
    expect(enhanced?.[1].text).toContain(
      '[CRITICAL BEHAVIORAL RULE FOR BEDROCK NOVA]',
    );
  });

  it('should return undefined if system prompt is undefined', () => {
    expect(enhanceBedrockSystemPrompt(undefined)).toBeUndefined();
  });
});
