// Google wire protocol; provider/model/API dispatch identifiers come from configuration.
export function createGeminiParser(model, emit) {
  const output = { role: "assistant", content: [], api: "google-generative-ai",
    provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
    usageMetadata: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const tokens = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0,
    cachedContentTokenCount: 0, totalTokenCount: 0 };
  let call, text, finishReason;
  const push = (type, fields) => emit({ type, ...fields, partial: output });
  const endText = () => {
    if (text) {
      push(`${text.kind}_end`, { contentIndex: text.index, content: text.block[text.field] });
      text = undefined;
    }
  };
  // Deltas are the growing prefix of JSON.stringify(arguments): fields arrive in order,
  // so only the containers on the newest path (and an open string) are still unclosed.
  const toolDelta = full => {
    if (full.startsWith(call.sent) && full.length > call.sent.length) {
      push("toolcall_delta", { contentIndex: call.index, delta: full.slice(call.sent.length) });
      call.sent = full;
    }
  };
  const openJson = () => {
    const full = JSON.stringify(call.block.arguments);
    return full.slice(0, full.length - call.depth - (call.stringPath ? 1 : 0));
  };
  // "$.a.b[0]" or "$['a']" -> ["a", "b", 0]
  const pathKeys = jsonPath => [...jsonPath.matchAll(/\.([^.[\]]+)|\[(\d+)\]|\['((?:[^'\\]|\\.)*)'\]/g)]
    .map(m => m[2] !== undefined ? Number(m[2]) : m[1] ?? m[3]);
  const fragment = arg => {
    const entry = Object.entries(arg).find(([name]) => name.endsWith("Value"));
    // A fragment carrying only jsonPath closes a string that was streamed in chunks.
    if (!entry) { call.stringPath = undefined; toolDelta(openJson()); return; }
    const [kind, raw] = entry;
    const value = kind === "nullValue" ? null : raw;
    const keys = pathKeys(arg.jsonPath);
    let node = call.block.arguments;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] === undefined) node[keys[i]] = typeof keys[i + 1] === "number" ? [] : {};
      node = node[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (call.stringPath === arg.jsonPath && typeof value === "string") node[last] += value;
    else node[last] = value;
    call.stringPath = kind === "stringValue" && arg.willContinue === true ? arg.jsonPath : undefined;
    call.depth = keys.length;
    toolDelta(openJson());
  };
  // Anything outside the expected shapes (blocks, upstream errors, unknown parts, odd
  // finishReasons) is collected verbatim and reported as the turn's error message.
  const unexpected = [];
  const note = (what, value) => unexpected.push(`${what}: ${(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 2000)}`);
  const routine = new Set(["candidates", "usageMetadata", "modelVersion", "responseId", "createTime"]);
  return {
    output,
    note,
    start() { push("start"); },
    frame(chunk) {
      output.responseId = chunk.responseId;
      output.upstreamModel = chunk.modelVersion;
      if (chunk.error) note("Gemini upstream error", chunk.error);
      if (chunk.promptFeedback?.blockReason) note("Gemini blocked the prompt", chunk.promptFeedback);
      else if (Object.keys(chunk).some(key => !routine.has(key) && key !== "promptFeedback" && key !== "error")) note("Gemini frame with unknown fields", chunk);
      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            endText();
            const fc = part.functionCall;
            if (fc.name) {
              const block = { type: "toolCall", id: fc.id, name: fc.name, arguments: {} };
              call = { block, index: output.content.length, sent: "", depth: 0 };
              output.content.push(block);
              push("toolcall_start", { contentIndex: call.index });
            }
            if (part.thoughtSignature) call.block.thoughtSignature = part.thoughtSignature;
            if (fc.args) Object.assign(call.block.arguments, fc.args);
            if (fc.partialArgs) for (const arg of fc.partialArgs) fragment(arg);
            if (fc.willContinue !== true) {
              toolDelta(JSON.stringify(call.block.arguments));
              push("toolcall_end", { contentIndex: call.index, toolCall: call.block });
              call = undefined;
            }
          } else if ("text" in part) {
            const kind = part.thought === true ? "thinking" : "text";
            const field = kind === "thinking" ? "thinking" : "text";
            if (!text || text.kind !== kind) {
              endText();
              const block = { type: kind, [field]: "" };
              text = { kind, field, block, index: output.content.length };
              output.content.push(block);
              push(`${kind}_start`, { contentIndex: text.index });
            }
            if (part.thoughtSignature) text.block[kind === "thinking" ? "thinkingSignature" : "textSignature"] = part.thoughtSignature;
            text.block[field] += part.text;
            push(`${kind}_delta`, { contentIndex: text.index, delta: part.text });
          } else if (Object.keys(part).some(key => key !== "thoughtSignature")) note("Gemini part not handled", part);
        }
        if (candidate.finishReason) {
          finishReason = candidate.finishReason;
          if (finishReason !== "STOP" && finishReason !== "MAX_TOKENS") note("Gemini finished abnormally", candidate);
        }
      }
      Object.assign(output.usageMetadata, chunk.usageMetadata);
      Object.assign(tokens, chunk.usageMetadata);
    },
    finish() {
      endText();
      const u = output.usage;
      u.cacheRead = tokens.cachedContentTokenCount;
      u.input = tokens.promptTokenCount - u.cacheRead;
      u.output = tokens.candidatesTokenCount + tokens.thoughtsTokenCount;
      u.totalTokens = tokens.totalTokenCount;
      u.reasoningTokens = tokens.thoughtsTokenCount;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) u.cost[key] = u[key] * model.cost[key] / 1e6;
      u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite;
      output.stopReason = finishReason === "STOP" && output.content.some(b => b.type === "toolCall")
        ? "toolUse" : { STOP: "stop", MAX_TOKENS: "length" }[finishReason];
      if (!output.stopReason && !unexpected.length) note("Gemini stream ended without finishReason", finishReason ?? "missing");
      if (!unexpected.length) emit({ type: "done", reason: output.stopReason, message: output });
      else {
        output.stopReason = "error";
        output.errorMessage = unexpected.join("\n");
        emit({ type: "error", reason: "error", error: output });
      }
      return output;
    },
  };
}

// The live request and offline replay both feed raw bytes through this parser.
export async function parseGeminiSSE(bytes, parser) {
  const decoder = new TextDecoder();
  let buffer = "", lines = [];
  const line = value => {
    if (value === "") {
      if (lines.length) {
        const data = lines.join("\n");
        lines = [];
        if (data !== "[DONE]") {
          let chunk;
          try { chunk = JSON.parse(data); } catch { parser.note("Gemini frame is not JSON", data); return; }
          parser.frame(chunk);
        }
      }
    } else if (value.startsWith("data:")) lines.push(value.slice(5).replace(/^ /, ""));
  };
  const drain = () => {
    let pos;
    while ((pos = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, pos).replace(/\r$/, ""));
      buffer = buffer.slice(pos + 1);
    }
  };
  for await (const chunk of bytes) { buffer += decoder.decode(chunk, { stream: true }); drain(); }
  buffer += decoder.decode();
  drain();
  if (buffer) line(buffer.replace(/\r$/, ""));
  line("");
  return parser.finish();
}

function inputPart(block) {
  switch (block.type) {
    case "text": return { text: block.text, thoughtSignature: block.textSignature };
    case "image": return { inlineData: { mimeType: block.mimeType, data: block.data } };
    case "thinking": return { text: block.thinking, thought: true, thoughtSignature: block.thinkingSignature };
    case "toolCall": return { functionCall: { name: block.name, id: block.id, args: block.arguments },
      thoughtSignature: block.thoughtSignature };
  }
}

function requestBody(model, context, options) {
  const contents = [];
  for (const message of context.messages) {
    // Aborted or failed turns may carry no parts; Gemini rejects empty parts with 400.
    if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) continue;
    let role, parts;
    if (message.role === "toolResult") {
      role = "user";
      const text = message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      const images = message.content.filter(b => b.type === "image").map(inputPart);
      parts = [{ functionResponse: { name: message.toolName, id: message.toolCallId,
        response: message.isError ? { error: text } : { output: text }, parts: images } }];
    } else {
      role = message.role === "assistant" ? "model" : "user";
      parts = typeof message.content === "string" ? [{ text: message.content }] : message.content.map(inputPart).filter(Boolean);
    }
    if (!parts.length) continue;
    // The gateway rejects a user turn that mixes functionResponse with plain text, so keep them apart.
    const tool = message.role === "toolResult";
    const last = contents[contents.length - 1];
    if (last && last.role === role && last.tool === tool) last.parts.push(...parts);
    else contents.push({ role, tool, parts });
  }
  for (const content of contents) delete content.tool;
  const generationConfig = { maxOutputTokens: options.maxTokens,
    temperature: options.temperature, topP: options.topP, topK: options.topK,
    stopSequences: options.stopSequences,
    thinkingConfig: { includeThoughts: !options.hideThinkingSummary, thinkingLevel: options.reasoning?.toUpperCase() } };
  const body = { contents, generationConfig };
  if (context.systemPrompt) body.systemInstruction = { parts: context.systemPrompt.map(text => ({ text })) };
  if (context.tools) {
    body.tools = [{ functionDeclarations: context.tools.map(tool => ({ name: tool.name,
      description: tool.description, parametersJsonSchema: tool.parameters })) }];
    body.toolConfig = { functionCallingConfig: { streamFunctionCallArguments: true } };
  }
  return body;
}

export function streamGemini(model, context, options) {
  const queue = [];
  let wake, done = false;
  const push = event => { queue.push(event); wake?.(); };
  const final = (async () => {
    const parser = createGeminiParser(model, push);
    parser.start();
    let result;
    try {
      const response = await globalThis.fetch(`${model.baseUrl}/models/${model.id}:streamGenerateContent?alt=sse`, {
        method: "POST", headers: { "Content-Type": "application/json", ...model.headers,
          ...options.headers, "x-goog-api-key": options.apiKey },
        body: JSON.stringify(requestBody(model, context, options)), signal: options.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      result = await parseGeminiSSE(response.body, parser);
    } catch (error) {
      result = parser.output;
      result.stopReason = options.signal?.aborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      push({ type: "error", reason: result.stopReason, error: result });
    }
    done = true;
    wake?.();
    return result;
  })();
  return {
    get done() { return done; },
    hasPendingLocalWork: false,
    localWorkSettledAt: 0,
    result() { return final; },
    async *[Symbol.asyncIterator]() {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift();
        else await Promise.race([final, new Promise(resolve => { wake = resolve; })]);
      }
      await final;
    },
  };
}

export default function geminiPartialArgs(pi) {
  const { name, ...config } = JSON.parse(process.env.OMP_GEMINI_PROVIDER);
  pi.registerProvider(name, { ...config, streamSimple: streamGemini });
}
