When building custom providers for the Gemini CLI, **you can expect native,
reliable, and structural separation of text, thoughts, and tools from both
Bedrock Nova and Ollama**, provided you configure them correctly.  
Both ecosystems have updated their APIs to treat "thinking" as an isolated data
block, meaning you **do not** have to write complex regex parsers to strip
\<thinking\> tags out of raw text blocks.  
Here is exactly how much you can rely on each platform and where their data
lives.

## **1\. AWS Bedrock Nova**

Amazon Nova supports native **Extended Thinking**. When you pass the
reasoningConfig parameter to the API, Bedrock automatically isolates thoughts
into structured blocks.

### **The Expectation: High**

- **Text & Tools:** Standard, native API blocks. Nova handles parallel tool
  calls perfectly.
- **Thoughts:** Fully separated by the engine.

### **The Data Shape to Map:**

During a ConverseStream, Bedrock separates the three into explicit, mutually
exclusive event blocks. Your adapter can simply route them based on the keys
present:

- **Thoughts (thought):** Look for the reasoningContent block.
- **Tools (tools):** Look for contentBlockStart/contentBlockDelta with toolUse.
- **Text (text):** Look for contentBlockDelta with text.

JSON  
// CHUNK 1: Thought Block  
{ "reasoningContent": { "text": "I need to look up the weather before
answering..." } }

// CHUNK 2: Tool Block  
{ "contentBlockStart": { "start": { "toolUse": { "name": "get\_weather" } } } }

// CHUNK 3: Text Block  
{ "contentBlockDelta": { "delta": { "text": "The current weather in London
is..." } } }

## **2\. Ollama (Local & Cloud Custom Models)**

Ollama has native support for **Thinking Models** (such as DeepSeek-R1, Qwen 3,
and Phi-4 Reasoning).

### **The Expectation: Medium to High (Model Dependent)**

- **Text & Thoughts:** Fully separated by Ollama _if_ you set "think": true in
  your API options. Ollama automatically strips the raw text of tags like
  \<think\> and redirects those tokens into a separate field.
- **Tools:** Relies entirely on whether the specific model you run in Ollama
  natively supports tool calling _alongside_ thinking. (For example, models like
  qwen3 and gemma4 handle both well, while pure reasoning models like
  deepseek-r1 often struggle with native structured tool syntax).

### **The Data Shape to Map:**

When streaming from Ollama's /api/chat, look at the properties inside the
message object of the chunk:

- **Thoughts (thought):** Populates the message.thinking string property.
- **Text (text):** Populates the message.content string property.
- **Tools (tools):** Populates the message.tool\_calls array property.

JSON  
// CHUNK 1: Ollama Thought  
{ "message": { "role": "assistant", "thinking": "Analyzing coordinates..." } }

// CHUNK 2: Ollama Text  
{ "message": { "role": "assistant", "content": "Here is your map." } }

## **3\. Translation Blueprint for your Gemini CLI Provider**

Because the Gemini CLI framework expects the target structure to cleanly isolate
text, tools, and thinking, your custom adapter can reliably map the incoming
streams into Gemini's parts array using this taxonomy:

| Target Component | Mapped from Bedrock Nova              | Mapped from Ollama        | Gemini CLI Target Schema Placement        |
| :--------------- | :------------------------------------ | :------------------------ | :---------------------------------------- |
| **Thoughts**     | chunk.reasoningContent.text           | chunk.message.thinking    | parts: \[{ thought: true, text: "..." }\] |
| **Text**         | chunk.contentBlockDelta.delta.text    | chunk.message.content     | parts: \[{ text: "..." }\]                |
| **Tools**        | chunk.contentBlockDelta.delta.toolUse | chunk.message.tool\_calls | parts: \[{ functionCall: { ... } }\]      |

### **Architectural Catch**

The only edge case you need to enforce in your custom provider is **state
switching**. A single stream chunk from Ollama or Bedrock will generally only
contain _one_ of these three types at a time. Your provider should simply look
at which key is populated in the incoming chunk, wrap it in Gemini's expected
array schema, and push it directly down the SSE line to the CLI.
