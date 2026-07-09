/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppRig } from './AppRig.js';
import { vi } from 'vitest';
import { act } from 'react';
import { AuthType } from '@google/gemini-cli-core';

/**
 * A dedicated test rig for simulating interactive user sessions using Bedrock Nova models.
 * This class inherits all React-Ink TUI rendering and message-passing loops from AppRig,
 * but overrides the environment and authentication layers to target Bedrock instead of Gemini.
 */
export class BedrockNovaAppRig extends AppRig {
  private authType: AuthType;

  constructor(
    options: {
      configOverrides?: { model?: string } & Record<string, unknown>;
    } & Record<string, unknown> = {},
  ) {
    super(options);
    this.authType = AuthType.BEDROCK_NOVA;
  }

  override async initialize() {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rootDir = process.cwd();

    // 1. Pre-stub AWS environment and credentials to satisfy environment checks
    vi.stubEnv(
      'AWS_CONFIG_FILE',
      process.env['AWS_CONFIG_FILE'] || path.resolve(rootDir, '.aws/config'),
    );
    vi.stubEnv(
      'AWS_PROFILE',
      process.env['AWS_PROFILE'] || 'Aerith-Development',
    );
    vi.stubEnv('AWS_SDK_LOAD_CONFIG', '1');
    vi.stubEnv(
      'GEMINI_API_KEY',
      process.env['GEMINI_API_KEY'] || 'test-api-key',
    );

    // 2. Call parent class initializer to set up the configuration and visual rig
    await super.initialize();

    // 2b. Automatically copy host MCP settings into the test instance to enable MCP integration (like AWS Docs)
    const hostSettingsPath = path.join(rootDir, '.gemini', 'settings.json');

    if (fs.existsSync(hostSettingsPath)) {
      try {
        const hostSettings = JSON.parse(
          fs.readFileSync(hostSettingsPath, 'utf8'),
        );
        if (hostSettings.mcpServers) {
          const testSettingsPath = path.join(
            this.getTestDir(),
            '.gemini',
            'user_settings.json',
          );
          let testSettings: Record<string, unknown> = {};
          if (fs.existsSync(testSettingsPath)) {
            testSettings = JSON.parse(
              fs.readFileSync(testSettingsPath, 'utf8'),
            );
          }

          // Inject MCP servers from host
          testSettings['mcpServers'] = hostSettings.mcpServers;
          fs.writeFileSync(
            testSettingsPath,
            JSON.stringify(testSettings, null, 2),
          );

          // Sync in-memory settings inside the test rig
          const rigSettings = (
            this as unknown as {
              settings: {
                merged?: Record<string, unknown>;
                user?: { settings?: Record<string, unknown> };
              };
            }
          ).settings;
          if (rigSettings) {
            rigSettings.merged = rigSettings.merged || {};
            rigSettings.merged['mcpServers'] = hostSettings.mcpServers;
            if (rigSettings.user && rigSettings.user.settings) {
              rigSettings.user.settings['mcpServers'] = hostSettings.mcpServers;
            }
          }
        }
      } catch (e: unknown) {
        process.stderr.write(
          '[BedrockNovaAppRig] Failed to inject host MCP settings: ' +
            (e as Error).message +
            '\n',
        );
      }
    }

    // 3. Re-stub default auth to the resolved auth type and refresh the authentication context
    vi.stubEnv('GEMINI_DEFAULT_AUTH_TYPE', this.authType);
    await act(async () => {
      await this.getConfig().refreshAuth(this.authType);
    });
  }
}
