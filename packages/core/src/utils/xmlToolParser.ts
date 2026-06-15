/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { debugLogger } from './debugLogger.js';

/**
 * Parses XML-style tool calls from a stream of text.
 * Format: <tool_name>JSON_ARGS</tool_name>
 */
export class XmlToolParser {
  private buffer = '';
  private readonly toolCallRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;

  /**
   * Adds new text to the parser and returns any complete tool calls found.
   */
  parse(text: string): FunctionCall[] {
    this.buffer += text;
    const calls: FunctionCall[] = [];
    let match: RegExpExecArray | null;

    // Reset regex lastIndex to search from start of buffer
    this.toolCallRegex.lastIndex = 0;

    while ((match = this.toolCallRegex.exec(this.buffer)) !== null) {
      const name = match[1];
      const argsStr = match[2].trim();
      let args: Record<string, unknown> = {};

      try {
        if (argsStr) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse(argsStr) as Record<string, unknown>;
        }
        calls.push({
          name,
          args,
        });
      } catch (e) {
        // If JSON parsing fails, it might be partial or invalid.
        // For now, we skip it but we might want to log it.
        debugLogger.log(
          `[XmlToolParser] Failed to parse args for tool ${name}:`,
          e,
        );
      }
    }

    // We don't clear the buffer yet because we might have partial tags.
    // However, if we found matches, we should ideally remove the matched parts
    // to avoid double-parsing.
    // But since we use the 'g' flag and process all matches, it's safer to
    // track what we've already emitted or just clear the buffer when a turn ends.

    return calls;
  }

  /**
   * Clears the internal buffer.
   */
  clear(): void {
    this.buffer = '';
  }

  /**
   * Robustly extracts all tool calls from a full text string.
   */
  static extractAll(text: string): FunctionCall[] {
    const parser = new XmlToolParser();
    return parser.parse(text);
  }
}
