---
title: Ollama Provider
description: Using Ollama models with Gemini CLI
sidebar_label: Ollama Provider
---

## Overview

The Ollama provider allows you to use local Ollama models with Gemini CLI. This
is particularly useful when you want to run models locally on your machine
without relying on cloud APIs.

## Prerequisites

Before using the Ollama provider, you need to:

1. **Install Ollama** - Follow the
   [Ollama installation instructions](https://ollama.ai/) for your platform
2. **Pull models** - Use `ollama pull` to download models to your local machine

## Basic Usage

To use the Ollama provider, set the appropriate environment variables:

```bash
# Set the model to use an Ollama model
export GEMINI_MODEL="ollama/llama3:8b-instruct-q5_K_M"

# Optional: Set custom Ollama API endpoint
# export OLLAMA_BASE_URL="http://localhost:11434"
```

### Example: Simple Chat

```bash
gemini "Hello, how are you today?"
```

The CLI will automatically detect that you're using an Ollama model and route
the request to your local Ollama instance.

## Configuration Options

The Ollama provider supports several configuration options:

### Environment Variables

| Variable          | Description                                  | Default                  |
| ----------------- | -------------------------------------------- | ------------------------ |
| `OLLAMA_BASE_URL` | Custom Ollama API endpoint URL               | `http://localhost:11434` |
| `GEMINI_MODEL`    | Model to use (format: `ollama/<model-name>`) | Required                 |

### Provider-Specific Settings

You can also configure the Ollama provider programmatically:

```javascript
const generator = new OllamaContentGenerator({
  baseUrl: 'http://custom-ollama:11434', // Custom API endpoint
  temperature: 0.2, // Lower temperature for more focused responses
  maxTokens: 1024, // Maximum tokens to generate
  topP: 0.9, // Top-p sampling parameter
});
```

## Supported Operations

The Ollama provider supports all standard Gemini CLI operations:

- **Chat completions** - `gemini "your prompt"`
- **Streaming chat** - Use `--stream` flag for streaming responses
- **Token counting** - Basic token counting (Ollama doesn't provide detailed
  token info)
- **Embeddings** - Generate text embeddings using Ollama models

## Model Selection for RTX 4090

For optimal performance on an RTX 4090 GPU, we recommend:

```bash
ollama pull llama3:8b-instruct-q5_K_M
```

This model provides:

- Good balance of speed and quality
- Quantized format (q5_K_M) for reduced VRAM usage
- Instruction tuning for chat-based interactions
- Efficient execution on CUDA-enabled GPUs

## Troubleshooting

### Common Issues

1. **Model not found errors**
   - Ensure you've pulled the model using `ollama pull`
   - Check that the model name in `GEMINI_MODEL` matches what's available
     locally

2. **Connection issues**
   - Verify Ollama is running (`ollama serve`)
   - Check network connectivity to the Ollama API endpoint

3. **Performance issues**
   - Use quantized models (q5_K_M suffix) for better GPU memory usage
   - Adjust temperature and maxTokens settings for your specific needs

### Debugging

You can enable debug logging to see detailed Ollama API interactions:

```bash
export DEBUG=ollama
gemini "test prompt"
```

## Next Steps

1. **Experiment with different models** - Try various Ollama models to find what
   works best for your use case
2. **Fine-tune performance** - Adjust configuration parameters like temperature,
   maxTokens, and topP
3. **Integrate with tools** - Combine Ollama with Gemini CLI's tool capabilities
   for enhanced functionality

The Ollama provider brings the power of local model execution to Gemini CLI,
giving you full control over your AI interactions while maintaining the familiar
Gemini CLI interface.
