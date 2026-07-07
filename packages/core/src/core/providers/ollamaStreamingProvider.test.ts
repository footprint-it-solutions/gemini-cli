/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { OllamaStreamingParser } from './ollamaStreamingProvider.js';

describe('OllamaStreamingParser BDD Spec', () => {
  it('should stream regular conversational text character-by-character', () => {
    const parser = new OllamaStreamingParser();
    const tokens = ['Hello', ' ', 'world', '!'];
    const results: string[] = [];

    for (const token of tokens) {
      for (const chunk of parser.processToken(token)) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          results.push(text);
        }
      }
    }

    for (const chunk of parser.flush()) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        results.push(text);
      }
    }

    expect(results.join('')).toBe('Hello world!');
  });

  it('should cleanly intercept XML tool call tags and never leak them as text', () => {
    const parser = new OllamaStreamingParser();
    const tokens = [
      'Sure! ',
      'Let me ',
      'read it.\n',
      '<tool_call name="read_file">',
      '{"file_path": "foo.txt"}',
      '</tool_call>',
      ' Done.',
    ];

    const textResults: string[] = [];
    const functionCalls: any[] = [];

    for (const token of tokens) {
      for (const chunk of parser.processToken(token)) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          textResults.push(text);
        }
        if (chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
        }
      }
    }

    for (const chunk of parser.flush()) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        textResults.push(text);
      }
    }

    const fullText = textResults.join('');
    expect(fullText).toContain('Sure! Let me read it.\n');
    expect(fullText).toContain(' Done.');
    expect(fullText).not.toContain('<tool_call');
    expect(fullText).not.toContain('</tool_call>');
    expect(fullText).not.toContain('foo.txt');

    expect(functionCalls.length).toBe(1);
    expect(functionCalls[0].name).toBe('read_file');
    expect(functionCalls[0].args).toEqual({ file_path: 'foo.txt' });
  });

  it('should be completely resilient to raw token fragments sliced across any border', () => {
    const parser = new OllamaStreamingParser();
    const tokens = [
      'Sure.\n',
      '<too', // Tag prefix sliced
      'l_call name="', // Tag suffix sliced
      'read_file',
      '">', // End of opening tag sliced
      '{"file_pa', // JSON key sliced
      'th": "foo.ts"}',
      '</tool_ca', // Closing tag prefix sliced
      'll>', // Closing tag suffix sliced
      ' Resuming text.',
    ];

    const textResults: string[] = [];
    const functionCalls: any[] = [];

    for (const token of tokens) {
      for (const chunk of parser.processToken(token)) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          textResults.push(text);
        }
        if (chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
        }
      }
    }

    for (const chunk of parser.flush()) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        textResults.push(text);
      }
    }

    const fullText = textResults.join('');
    expect(fullText).toBe('Sure.\n Resuming text.');
    expect(fullText).not.toContain('foo.ts');
    expect(fullText).not.toContain('<tool_call');

    expect(functionCalls.length).toBe(1);
    expect(functionCalls[0].name).toBe('read_file');
    expect(functionCalls[0].args).toEqual({ file_path: 'foo.ts' });
  });

  it('should ignore unrelated mathematical less-than signs and flush them cleanly', () => {
    const parser = new OllamaStreamingParser();
    const tokens = [
      'Comparing numbers: ',
      '5 < ', // Potential start but actually a less-than sign
      '10 is true.',
      ' Also, x ',
      '<to', // Looks closer to tool_call but mismatch
      ' is not a tag.',
    ];

    const textResults: string[] = [];

    for (const token of tokens) {
      for (const chunk of parser.processToken(token)) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          textResults.push(text);
        }
      }
    }

    for (const chunk of parser.flush()) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        textResults.push(text);
      }
    }

    const fullText = textResults.join('');
    expect(fullText).toBe(
      'Comparing numbers: 5 < 10 is true. Also, x <to is not a tag.',
    );
  });
});
