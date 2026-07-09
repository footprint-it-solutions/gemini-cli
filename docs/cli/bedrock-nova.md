---
title: Bedrock Nova Provider
description: Using AWS Bedrock Nova models with Gemini CLI
sidebar_label: Bedrock Nova Provider
---

## Overview

The Bedrock Nova provider lets you use AWS Bedrock Nova models as a drop-in
replacement with Gemini CLI. This lets you execute interactive code reasoning,
multi-turn tool calling, and full agentic sessions powered by Amazon Bedrock's
highly performant and cost-effective Nova model families.

<!-- prettier-ignore -->
> [!NOTE]
> Tool-calling turn auto-continuation is fully supported under Bedrock Nova.
> If Bedrock returns truncated monologue segments or incomplete planning,
> Gemini CLI automatically continues the turn until the model completes its task.

## Prerequisites

Before using the Bedrock Nova provider, you must have the following:

1. **An AWS Account** - Access to Amazon Bedrock in a supported region (for
   example, `eu-west-1` or `us-east-1`).
2. **Model Access** - Enable access to Nova models (such as
   `amazon.nova-lite-v1` and `amazon.nova-pro-v1`) inside your AWS Bedrock
   control panel.
3. **AWS Credentials** - Configured credentials in your local environment,
   either via SSO, an AWS credentials file, or direct environment variables.

## Basic Usage

To configure Gemini CLI to use the Bedrock Nova provider, set your default auth
type and configured model:

```bash
# Set Gemini CLI default authentication type to Bedrock
export GEMINI_DEFAULT_AUTH_TYPE="bedrock"

# Set the active model to Bedrock Nova Lite
export GEMINI_MODEL="bedrock/eu.amazon.nova-2-lite-v1:0"

# Optional: Set your AWS profile
export AWS_PROFILE="Aerith-Development"
```

### Example: Interactive Coding Session

Simply run Gemini CLI normally to begin a Bedrock-backed conversation:

```bash
gemini "Refactor src/math.ts to use precise multiplication"
```

## Configuration Options

The Bedrock Nova provider supports several environment variables to tune client
behavior:

| Variable                                  | Description                                             | Default     |
| ----------------------------------------- | ------------------------------------------------------- | ----------- |
| `AWS_BEDROCK_REGION`                      | The AWS region to resolve Bedrock clients               | `eu-west-1` |
| `AWS_PROFILE`                             | The AWS configuration profile to load credentials from  | None        |
| `BEDROCK_PREFIX`                          | Override the model prefix (such as `eu` or `us`)        | None        |
| `GEMINI_CLI_BEDROCK_USE_MICRO_CLASSIFIER` | Toggle the Nova Micro-based next-speaker classification | `true`      |

## Troubleshooting

### Common Issues

1. **Authentication Failures (`CredentialsProviderError`)**
   - Verify that your active `AWS_PROFILE` is logged in (for example, run
     `aws sso login`).
   - If using direct keys, check that `AWS_ACCESS_KEY_ID` and
     `AWS_SECRET_ACCESS_KEY` are correct.

2. **Model Truncation or Cut-Off Responses**
   - Bedrock Nova Lite has a default limit of 10,000 maximum output tokens.
   - If responses end abruptly mid-sentence, ensure that the auto-continuation
     budget has not been exhausted. Gemini CLI will automatically attempt up to
     100 continuations to finish the turn.

3. **Unknown API Errors**
   - Check that Amazon Bedrock has the requested model enabled in your active
     AWS region.

## Next Steps

1. **Verify Your Connection** - Run a simple query to confirm credential
   routing:
   ```bash
   gemini -p "Confirm your model type"
   ```
2. **Enable Agentic Workflows** - Enable file management and execution tools to
   unlock Bedrock-driven codebase modification.
