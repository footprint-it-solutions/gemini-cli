/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Centered logging utility for local and custom LLM providers.
 * Generates bedrock-debug.log, ollama-debug.log, and ollama-stream-debug.log.
 */
export class ProviderLogger {
  private static streams: Record<string, fs.WriteStream> = {};
  private static sessionSuffix: string | null = null;

  private static getSessionSuffix(): string {
    if (!this.sessionSuffix) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      this.sessionSuffix = `${dateStr}-${timeStr}`;
    }
    return this.sessionSuffix;
  }

  private static getStream(filename: string): fs.WriteStream {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const timestampedName = `${base}-${this.getSessionSuffix()}${ext}`;

    if (!this.streams[timestampedName]) {
      const logPath = path.resolve(process.cwd(), timestampedName);
      this.streams[timestampedName] = fs.createWriteStream(logPath, {
        flags: 'a',
      });
      this.streams[timestampedName].on('error', (err) => {
        // Fallback console logging on failure, avoiding process crashes
        console.error(
          `[ProviderLogger] Error writing to ${timestampedName}:`,
          err,
        );
      });
    }
    return this.streams[timestampedName];
  }

  /**
   * General purpose logging into a specific log file with Level and formatted data.
   */
  public static log(
    filename: string,
    level: 'REQUEST' | 'RESPONSE' | 'CHUNK' | 'ERROR' | 'INFO',
    message: string,
    data?: any,
  ): void {
    try {
      const stream = this.getStream(filename);
      const timestamp = new Date().toISOString();
      let formattedData = '';

      if (data !== undefined) {
        // Redact sensitive or large content before logging
        const safeData = this.redact(data);
        if (typeof safeData === 'object') {
          try {
            formattedData = '\n' + JSON.stringify(safeData, null, 2);
          } catch {
            formattedData = ' ' + String(safeData);
          }
        } else {
          formattedData = ' ' + String(safeData);
        }
      }

      const logEntry = `[${timestamp}] [${level}] ${message}${formattedData}\n\n`;
      stream.write(logEntry);
    } catch (e) {
      console.error(`[ProviderLogger] Failed logging to ${filename}:`, e);
    }
  }

  /**
   * Recursively redacts large content or file data from log objects.
   */
  private static redact(obj: any, depth = 0): any {
    if (depth > 10 || obj === null || typeof obj !== 'object') {
      // Basic truncation for very long strings that aren't in objects
      if (typeof obj === 'string' && obj.length > 1000) {
        return `[REDACTED: string length ${obj.length}]`;
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redact(item, depth + 1));
    }

    const redacted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      // 1. Redact known content-heavy fields
      if (typeof value === 'string') {
        // Redact file contents in tool responses or write requests
        if (
          lowerKey === 'content' ||
          lowerKey === 'output' ||
          lowerKey === 'result' ||
          lowerKey === 'text'
        ) {
          if (value.length > 500) {
            redacted[key] = `[REDACTED: content length ${value.length}]`;
            continue;
          }
        }

        // Special handling for arguments_json which might contain large file contents
        if (lowerKey === 'arguments_json') {
          try {
            const parsed = JSON.parse(value);
            // If it's a file write or similar, redact 'content' or 'text'
            if (parsed.content || parsed.text) {
              const safeArgs = this.redact(parsed, depth + 1);
              redacted[key] = JSON.stringify(safeArgs);
              continue;
            }
          } catch {
            // Not JSON
          }
        }
      }

      // 2. Recursive redaction for nested objects
      redacted[key] = this.redact(value, depth + 1);
    }
    return redacted;
  }

  public static logRequest(
    filename: string,
    model: string,
    payload: any,
  ): void {
    this.log(
      filename,
      'REQUEST',
      `Sending request to model: ${model}`,
      payload,
    );
  }

  public static logResponse(
    filename: string,
    model: string,
    payload: any,
  ): void {
    this.log(
      filename,
      'RESPONSE',
      `Received response from model: ${model}`,
      payload,
    );
  }

  public static logStreamChunk(
    filename: string,
    model: string,
    chunk: string,
  ): void {
    this.log(
      filename,
      'CHUNK',
      `Received stream token for model: ${model}`,
      chunk,
    );
  }

  public static logError(filename: string, model: string, error: any): void {
    const errDetails = {
      message: error?.message || String(error),
      stack: error?.stack,
      ...error,
    };
    this.log(
      filename,
      'ERROR',
      `Error in provider execution for model: ${model}`,
      errDetails,
    );
  }
}
