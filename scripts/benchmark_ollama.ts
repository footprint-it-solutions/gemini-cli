/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';

interface BenchmarkResult {
  name: string;
  ttft: number;
  totalDuration: number;
  totalTokens: number;
  tokensPerSec: number;
}

async function runBenchmark(
  host: string,
  model: string,
  name: string,
): Promise<BenchmarkResult> {
  const url = `${host}/api/generate`;
  const prompt =
    'Write a 150-word summary explaining the advantages of high-speed Direct Attach Copper (DAC) cables in networking. Be concise.';

  console.log(`\n======================================================`);
  console.log(`Starting Benchmark for ${name}`);
  console.log(`Endpoint: ${url}`);
  console.log(`Model: ${model}`);
  console.log(`------------------------------------------------------`);

  const startTime = performance.now();
  let firstTokenTime = 0;
  let totalTokens = 0;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: {
        temperature: 0.2,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Failed to open readable stream on response.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (!firstTokenTime) {
          firstTokenTime = performance.now();
        }

        if (parsed.response) {
          totalTokens++;
          process.stdout.write(parsed.response);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  const endTime = performance.now();
  const ttft = firstTokenTime - startTime;
  const totalDuration = (endTime - startTime) / 1000;
  const generationDuration = (endTime - firstTokenTime) / 1000;
  const tokensPerSec = totalTokens / generationDuration;

  console.log(`\n\n------------------------------------------------------`);
  console.log(`Results for ${name}:`);
  console.log(`- Time to First Token (TTFT): ${ttft.toFixed(1)} ms`);
  console.log(`- Total Ingestion-to-End: ${totalDuration.toFixed(2)} seconds`);
  console.log(
    `- Active Generation Duration: ${generationDuration.toFixed(2)} seconds`,
  );
  console.log(`- Total Tokens Generated: ${totalTokens}`);
  console.log(`- Decode Performance: ${tokensPerSec.toFixed(1)} tokens/second`);
  console.log(`======================================================`);

  return { name, ttft, totalDuration, totalTokens, tokensPerSec };
}

async function main() {
  const results: BenchmarkResult[] = [];

  try {
    // 1. Benchmark Local Workstation RTX 4090
    try {
      const localResult = await runBenchmark(
        'http://localhost:11434',
        'gemma4-local',
        'Local Node (RTX 4090 / gemma4-local:12b)',
      );
      results.push(localResult);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('FAIL: Workstation local node benchmark failed:', msg);
    }

    // 2. Benchmark Remote VM Server RTX 5090
    try {
      const remoteResult = await runBenchmark(
        'http://x10srh-1-bm:11434',
        'gemma4-remote',
        'Remote Server (RTX 5090 / gemma4-remote:26b)',
      );
      results.push(remoteResult);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('FAIL: Remote server node benchmark failed:', msg);
    }

    // 3. Output Comparative Head-to-Head Analysis
    if (results.length === 2) {
      console.log(`\n======================================================`);
      console.log(`           HEAD-TO-HEAD COMPARATIVE SPEC              `);
      console.log(`======================================================`);
      console.log(
        `Local Workstation 4090 Speed:  ${results[0].tokensPerSec.toFixed(1)} Tok/sec`,
      );
      console.log(
        `Remote Server 5090 MoE Speed:  ${results[1].tokensPerSec.toFixed(1)} Tok/sec`,
      );
      console.log(`------------------------------------------------------`);

      const factor = results[0].tokensPerSec / results[1].tokensPerSec;
      if (factor > 1) {
        console.log(
          `Local Node (12B) is ${(factor * 100 - 100).toFixed(0)}% FASTER than Remote Node (26B MoE)`,
        );
      } else {
        const remoteFactor = results[1].tokensPerSec / results[0].tokensPerSec;
        console.log(
          `Remote Node (26B MoE) is ${(remoteFactor * 100 - 100).toFixed(0)}% FASTER than Local Node (12B)`,
        );
      }
      console.log(
        `Note: Gemma 4 26B uses a Mixture of Experts architecture. Even though it is twice the parameter size,`,
      );
      console.log(
        `it utilizes GDDR7 memory speeds on the RTX 5090 to deliver high-quality reasoning extremely fast.`,
      );
      console.log(`======================================================\n`);
    }
  } catch (error) {
    console.error('CRITICAL: Benchmark failed:', error);
  }
}

main();
