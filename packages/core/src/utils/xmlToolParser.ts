/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { debugLogger } from './debugLogger.js';

/**
 * Parses tool calls from a stream of text.
 * Handles both XML-style tags and JSON code blocks.
 */
export class XmlToolParser {
  private buffer = '';

  // Format: <tool_name>JSON_ARGS</tool_name>
  private readonly xmlTagRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;

  // Format: ```json { "name": "...", "arguments": { ... } } ```
  private readonly jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;

  /**
   * Adds new text to the parser and returns any complete tool calls found.
   */
  parse(text: string): FunctionCall[] {
    this.buffer += text;
    const calls: FunctionCall[] = [];

    // 1. Check for XML Tags
    this.xmlTagRegex.lastIndex = 0;
    let xmlMatch: RegExpExecArray | null;
    while ((xmlMatch = this.xmlTagRegex.exec(this.buffer)) !== null) {
      const name = xmlMatch[1];
      const argsStr = xmlMatch[2].trim();
      let args: Record<string, unknown> = {};

      try {
        if (argsStr) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse(argsStr) as Record<string, unknown>;
        }
        calls.push({ name, args });
      } catch (e) {
        debugLogger.log(
          `[XmlToolParser] Failed to parse XML args for tool ${name}:`,
          e,
        );
      }
    }

    // 2. Check for JSON Code Blocks
    this.jsonBlockRegex.lastIndex = 0;
    let jsonMatch: RegExpExecArray | null;
    while ((jsonMatch = this.jsonBlockRegex.exec(this.buffer)) !== null) {
      const jsonStr = jsonMatch[1].trim();
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const obj = JSON.parse(jsonStr);

        // Match standard formats
        if (obj && typeof obj === 'object') {
          // Supports { name, arguments }, { toolName, parameters }, { tool, args }
          // and also { type: "mcp_call", name, arguments }
          const name = obj.name || obj.toolName || obj.tool;
          const args = obj.arguments || obj.parameters || obj.args || {};

          if (typeof name === 'string' && name.length > 0) {
            calls.push({
              name,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              args: typeof args === 'object' ? args : {},
            });
          }
        }
      } catch (e) {
        // Might be partial JSON during streaming
        debugLogger.log(`[XmlToolParser] Failed to parse JSON block:`, e);
      }
    }

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
