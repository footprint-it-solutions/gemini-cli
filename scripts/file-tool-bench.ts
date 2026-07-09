/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { makeFakeConfig } from '../packages/core/src/test-utils/config.js';

/**
 * File Tool Bench
 * Programmatically loads all registered workspace tools, inspects their parameters,
 * and audits them for potential schema hallucinations or Bedrock mapping issues.
 */
async function runBench() {
  console.log('\n============================================================');
  console.log('FILE TOOL BENCH: SCHEMAS & COMPLIANCE AUDIT');
  console.log('============================================================');

  const config = makeFakeConfig({
    targetDir: process.cwd(),
    cwd: process.cwd(),
  });

  // Create tool registry via the main configuration builder
  const registry = await config.createToolRegistry();

  // Get active tools through getFunctionDeclarations (this mimics the exact schemas sent to LLMs)
  const declarations = (
    registry as unknown as {
      getFunctionDeclarations: () => Array<{
        name: string;
        description?: string;
        parametersJsonSchema?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
        parameters?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      }>;
    }
  ).getFunctionDeclarations();

  console.log(`Loaded ${declarations.length} registered workspace tools.\n`);

  for (const spec of declarations) {
    const name = spec.name;
    const desc = spec.description || 'No description';
    const params = spec.parametersJsonSchema || spec.parameters || {};
    const required = params.required || [];
    const props = params.properties || {};

    console.log(`[Tool] Name: ${name}`);
    console.log(`       Desc: ${desc.slice(0, 80)}...`);
    console.log(`       Required Parameters: [${required.join(', ')}]`);

    console.log('       Declared Properties:');
    for (const [propName, propSpec] of Object.entries(props)) {
      const pType = (propSpec as { type?: string }).type || 'unknown';
      const pDesc =
        (propSpec as { description?: string }).description || 'No description';
      console.log(
        `         - ${propName} (${pType}): ${pDesc.slice(0, 100)}${pDesc.length > 100 ? '...' : ''}`,
      );
    }

    // Specific anti-hallucination checks for core file tools
    if (name === 'replace') {
      const hasContent = 'content' in props;
      const hasOldString = 'old_string' in props;
      const hasNewString = 'new_string' in props;

      console.log('\n       --> ANTI-HALLUCINATION AUDIT (replace):');
      if (hasContent) {
        console.log(
          '           ✖ WARNING: replace has a "content" parameter. Ensure model does not confuse this with write_file.',
        );
      } else {
        console.log(
          '           ✓ OK: replace does not have a confusing "content" parameter.',
        );
      }
      if (hasOldString && hasNewString) {
        console.log(
          '           ✓ OK: replace requires "old_string" and "new_string" for surgical replacement.',
        );
      } else {
        console.log(
          '           ✖ ERROR: replace is missing old_string/new_string definitions!',
        );
      }
    }

    if (name === 'write_file') {
      const hasContent = 'content' in props;
      console.log('\n       --> ANTI-HALLUCINATION AUDIT (write_file):');
      if (hasContent) {
        console.log(
          '           ✓ OK: write_file has standard "content" parameter.',
        );
      } else {
        console.log(
          '           ✖ ERROR: write_file is missing its "content" parameter!',
        );
      }
    }

    console.log('------------------------------------------------------------');
  }

  console.log(
    '\nAudit complete.\n============================================================\n',
  );
}

runBench().catch(console.error);
