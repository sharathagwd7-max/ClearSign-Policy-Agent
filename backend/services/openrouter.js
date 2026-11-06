
function cleanGeminiSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map(cleanGeminiSchema);
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const cleaned = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    cleaned[key] = cleanGeminiSchema(value);
  }

  return cleaned;
}

// --------------------------------------------------
// CONVERT TOOLS
// --------------------------------------------------

function convertToolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];

  const declarations = tools
    .filter(tool => tool.type === 'function' && tool.function)
    .map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: cleanGeminiSchema(
        tool.function.parameters || {
          type: 'object',
          properties: {}
        }
      )
    }));

  return declarations.length
    ? [{ functionDeclarations: declarations }]
    : [];
}

// --------------------------------------------------
// CONVERT MESSAGES
// --------------------------------------------------

function convertMessagesToGemini(messages) {
  const contents = [];
  const toolNamesById = new Map();

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{
          text: String(message.content || '')
        }]
      });

      continue;
    }

    if (message.role === 'assistant') {
      const parts = [];

      if (
        typeof message.content === 'string' &&
        message.content.trim()
      ) {
        parts.push({
          text: message.content
        });
      }

      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const name = call.function?.name;

          if (!name) continue;

          let args = {};

          try {
            args = JSON.parse(
              call.function.arguments || '{}'
            );
          } catch {
            args = {};
          }

          toolNamesById.set(call.id, name);

          const functionCallPart = {
            functionCall: {
              id: call.id,
              name,
              args
            }
          };

          // Preserve Gemini thought signatures.
          const signature =
            call.extra_content?.google?.thought_signature;

          if (signature) {
            functionCallPart.thoughtSignature = signature;
          }

          parts.push(functionCallPart);
        }
      }

      if (parts.length) {
        contents.push({
          role: 'model',
          parts
        });
      }

      continue;
    }

    if (message.role === 'tool') {
      const functionName =
        toolNamesById.get(message.tool_call_id) ||
        'unknown_tool';

      let result;

      try {
        result = JSON.parse(message.content || '{}');
      } catch {
        result = {
          output: String(message.content || '')
        };
      }

      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id: message.tool_call_id,
            name: functionName,
            response: result
          }
        }]
      });
    }
  }

  return contents;
}

// --------------------------------------------------
// CONVERT GEMINI RESPONSE
// --------------------------------------------------

function convertGeminiResponse(data) {
  const candidate = data.candidates?.[0];

  if (!candidate) {
    const blockReason = data.promptFeedback?.blockReason;

    if (blockReason) {
      throw new Error(
        `Gemini blocked the request: ${blockReason}`
      );
    }

    throw new Error(
      'Gemini returned no response candidate.'
    );
  }

  const parts = candidate.content?.parts || [];

  const text = parts
    .filter(part => typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();

  const toolCalls = parts
    .filter(part => part.functionCall)
    .map((part, index) => {
      const call = part.functionCall;

      return {
        id: call.id || `gemini_call_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args || {})
        },
        ...(part.thoughtSignature
          ? {
              extra_content: {
                google: {
                  thought_signature: part.thoughtSignature
                }
              }
            }
          : {})
      };
    });

  // Do not silently convert an empty Gemini response into
  // a normal-looking assistant response.
  if (!text && !toolCalls.length) {
    const finishReason = candidate.finishReason || 'UNKNOWN';

    const safetyDetails = Array.isArray(candidate.safetyRatings)
      ? candidate.safetyRatings
          .filter(item => item.blocked)
          .map(item => item.category)
          .join(', ')
      : '';

    throw new Error(
      `Gemini returned an empty response. Finish reason: ${finishReason}.` +
      (safetyDetails
        ? ` Safety categories: ${safetyDetails}.`
        : '')
    );
  }

  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length
          ? { tool_calls: toolCalls }
          : {})
      },
      finish_reason: toolCalls.length
        ? 'tool_calls'
        : String(candidate.finishReason || 'stop').toLowerCase()
    }]
  };
}

// --------------------------------------------------
// GEMINI CHAT COMPLETION
// --------------------------------------------------

async function chatCompletion(messages, tools, options = {}) {
  const key = process.env.GEMINI_API_KEY;

  if (!key || key === 'replace_with_your_key') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add your Gemini API key to backend/.env.'
    );
  }

  const model =
    process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  // IMPORTANT:
  // Pass ALL system messages to Gemini.
  // This includes the final-answer instruction appended
  // by orchestrator.js.
  const systemMessages = messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content || '').trim())
    .filter(Boolean);

  const contents = convertMessagesToGemini(messages);

  if (!contents.length) {
    throw new Error(
      'No valid messages were provided to Gemini.'
    );
  }

  const payload = {
    contents,
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 2000
    }
  };

  if (systemMessages.length) {
    payload.systemInstruction = {
      parts: [{
        text: systemMessages.join('\n\n')
      }]
    };
  }

  // Do not provide tools when the orchestrator requests
  // a final answer.
  if (!options.forceFinal) {
    const geminiTools = convertToolsToGemini(tools);

    if (geminiTools.length) {
      payload.tools = geminiTools;

      payload.toolConfig = {
        functionCallingConfig: {
          mode: 'AUTO'
        }
      };
    }
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    60000
  );

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error?.message ||
        `Gemini API returned HTTP ${response.status}`
      );
    }

    return convertGeminiResponse(data);

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        'Gemini API request timed out after 60 seconds.'
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  chatCompletion
};
