/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppRig } from './AppRig.js';
import { vi } from 'vitest';
import { act } from 'react';
import { AuthType, getAuthTypeFromEnv } from '@google/gemini-cli-core';
import { createMockSettings } from './settings.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Define the Mock EKS MCP Server implementation as a string
const mockMcpScript = `#!/usr/bin/env node
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    const id = request.id;
    
    if (request.method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'awslabs-aws-documentation-mcp-server',
            version: '1.0.0'
          }
        }
      };
      console.log(JSON.stringify(response));
    } else if (request.method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'mcp_awslabs-aws-documentation-mcp-server_search_documentation',
              description: 'Search AWS documentation using the official AWS Documentation Search API.',
              inputSchema: {
                type: 'object',
                properties: {
                  search_phrase: { type: 'string', description: 'Query' }
                },
                required: ['search_phrase']
              }
            },
            {
              name: 'mcp_awslabs-aws-documentation-mcp-server_read_sections',
              description: 'Extract specific sections from AWS documentation pages by title.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  section_titles: { type: 'array', items: { type: 'string' } }
                },
                required: ['url', 'section_titles']
              }
            }
          ]
        }
      };
      console.log(JSON.stringify(response));
    } else if (request.method === 'tools/call') {
      const toolName = request.params.name;
      const args = request.params.arguments;
      let text = '';
      
      if (toolName.endsWith('search_documentation')) {
        text = 'Search results:\\n1. URL: https://docs.aws.amazon.com/eks/latest/userguide/create-cluster.html\\nTitle: Creating an Amazon EKS cluster\\nSections: ["Prerequisites", "Step 1: Create your cluster", "Best practices"]';
      } else if (toolName.endsWith('read_sections')) {
        text = '### Creating an Amazon EKS cluster\\nAmazon Elastic Kubernetes Service (Amazon EKS) is a managed service that makes it easy for you to run Kubernetes on AWS.\\n\\n#### Prerequisites\\n- An IAM role for EKS cluster\\n- A VPC with private subnets';
      }
      
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text
            }
          ]
        }
      };
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    // Ignore invalid JSON
  }
});
`;

/**
 * A dedicated test rig for simulating interactive user sessions using local or remote vLLM models.
 * This class inherits all React-Ink TUI rendering and message-passing loops from AppRig,
 * but overrides the environment and authentication layers to target vLLM instead of Gemini.
 */
export class VllmAppRig extends AppRig {
  override async initialize() {
    // 1. Pre-stub GEMINI_API_KEY to satisfy the parent class environment check
    vi.stubEnv(
      'GEMINI_API_KEY',
      process.env['GEMINI_API_KEY'] || 'test-api-key',
    );

    // 2. Call parent class initializer to set up the configuration and visual rig
    await super.initialize();

    // 3. Write our mock EKS MCP server into the test workspace directory
    const mcpScriptPath = path.join(this.getTestDir(), 'mock-mcp.cjs');
    fs.writeFileSync(mcpScriptPath, mockMcpScript, { mode: 0o755 });

    // 4. Re-stub default auth to VLLM, configure custom MCP servers & planning settings,
    // and refresh the authentication context
    vi.stubEnv('GEMINI_DEFAULT_AUTH_TYPE', AuthType.VLLM);

    const plansDir = path.join(this.getTestDir(), 'plans');
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const mergedSettings = {
      security: {
        auth: {
          selectedType: AuthType.VLLM,
          useExternal: true,
        },
        folderTrust: {
          enabled: true,
        },
      },
      ide: {
        enabled: false,
        hasSeenNudge: true,
      },
      ui: {
        useAlternateBuffer: false,
      },
      general: {
        plan: { enabled: true, directory: plansDir },
        defaultApprovalMode: 'plan',
      },
      mcpServers: {
        'awslabs-aws-documentation-mcp-server': {
          command: 'node',
          args: [mcpScriptPath],
        },
      },
    };

    this.settings = createMockSettings({
      user: {
        path: path.join(this.getTestDir(), '.gemini', 'user_settings.json'),
        settings: mergedSettings,
        originalSettings: {},
      },
      merged: mergedSettings,
    });

    await act(async () => {
      const authType =
        getAuthTypeFromEnv(this.getConfig().getModel()) || AuthType.VLLM;
      await this.getConfig().refreshAuth(authType);
    });
  }
}
