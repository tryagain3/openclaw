import { extractText } from "../chat/message-extract";
import type { GatewayBrowserClient } from "../gateway";
import type { ChatAttachment } from "../ui-types";
import { generateUUID } from "../uuid";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function maskToken(token: string | undefined | null): string {
  if (!token || token.length === 0) return "(empty)";
  if (token.length <= 8) return "***";
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  
  state.chatLoading = true;
  state.lastError = null;
  try {
    const requestParams = {
      sessionKey: state.sessionKey,
      limit: 200,
    };
    
    // Extract connection info from client (if available)
    const clientInfo = state.client as unknown as {
      opts?: { url?: string; token?: string; password?: string };
      ws?: WebSocket;
    };
    const gatewayUrl = clientInfo.opts?.url ?? "unknown";
    const token = clientInfo.opts?.token;
    const hasPassword = !!clientInfo.opts?.password;
    const wsState = clientInfo.ws?.readyState;
    const wsStateText = wsState !== undefined 
      ? ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][wsState] ?? `unknown(${wsState})`
      : "unknown";
    
    console.group(`%c[API] chat.history`, "color: #2196F3; font-weight: bold");
    console.log("🔌 Connection:", {
      gatewayUrl,
      token: maskToken(token),
      hasToken: !!token,
      hasPassword,
      wsState: wsStateText,
      connected: state.connected,
    });
    console.log("📤 Request:", requestParams);
    
    const requestStartTime = Date.now();
    let res: {
      messages?: unknown[];
      thinkingLevel?: string | null;
      modelProvider?: string;
      modelId?: string;
      modelBaseUrl?: string;
      modelApi?: string;
    };
    
    try {
      res = (await state.client.request("chat.history", requestParams)) as {
        messages?: unknown[];
        thinkingLevel?: string | null;
        modelProvider?: string;
        modelId?: string;
        modelBaseUrl?: string;
        modelApi?: string;
      };
      const requestDuration = Date.now() - requestStartTime;
      console.log(`✅ Request succeeded (${requestDuration}ms)`);
    } catch (err) {
      const requestDuration = Date.now() - requestStartTime;
      console.error(`❌ Request failed (${requestDuration}ms):`, err);
      console.error("Error details:", {
        name: err instanceof Error ? err.name : "Unknown",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      console.groupEnd();
      throw err;
    }
    
    const requestDuration = Date.now() - requestStartTime;
    const messageCount = Array.isArray(res.messages) ? res.messages.length : 0;
    const hasMessages = "messages" in res;
    const messagesIsArray = Array.isArray(res.messages);
    
    const modelProvider = res.modelProvider;
    const modelId = res.modelId;
    const modelBaseUrl = res.modelBaseUrl;
    const modelApi = res.modelApi;
    
    // Log response summary matching backend format
    console.log("📥 Response:", {
      duration: `${requestDuration}ms`,
      messageCount,
      hasMessages,
      messagesIsArray,
      thinkingLevel: res.thinkingLevel,
      modelProvider: typeof modelProvider === "string" ? modelProvider : undefined,
      modelId: typeof modelId === "string" ? modelId : undefined,
      modelBaseUrl: typeof modelBaseUrl === "string" ? modelBaseUrl : undefined,
      modelApi: typeof modelApi === "string" ? modelApi : undefined,
      responseKeys: res !== null && typeof res === "object" ? Object.keys(res) : [],
    });
    
    // Log model provider info in format matching backend [MODEL] logs
    if (modelProvider && modelId) {
      console.log(`[MODEL] chat.history response: provider=${modelProvider} model=${modelId} baseUrl=${modelBaseUrl ?? "default"} api=${modelApi ?? "unknown"} sessionKey=${state.sessionKey} messageCount=${messageCount}`);
      console.log("🤖 Model Provider Details:", {
        provider: modelProvider,
        model: modelId,
        baseUrl: modelBaseUrl ?? "default",
        api: modelApi ?? "unknown",
      });
    } else {
      console.warn("[MODEL] chat.history response: model provider info missing");
    }
    
    // Log full raw response structure for debugging
    console.log("🔍 Raw response structure:", JSON.parse(JSON.stringify(res)));
    
    // Validate response
    if (!res || typeof res !== "object") {
      console.error("❌ Invalid response: not an object", { res, resType: typeof res });
      console.groupEnd();
      throw new Error(`Invalid response: expected object, got ${typeof res}`);
    }
    
    if (!hasMessages) {
      console.warn("⚠️ Response missing 'messages' property");
      console.log("Full response object:", res);
      console.log("Response type:", typeof res);
      console.log("Response keys:", Object.keys(res));
    } else if (!messagesIsArray) {
      console.error("❌ Response 'messages' is not an array", {
        messagesType: typeof res.messages,
        messagesValue: res.messages,
        messagesConstructor: res.messages?.constructor?.name,
      });
    } else if (messageCount === 0) {
      console.warn("⚠️ Response has empty messages array");
      console.log("Full response:", JSON.parse(JSON.stringify(res)));
      console.log("Response keys:", Object.keys(res));
      console.log("Messages property value:", res.messages);
      console.log("Messages type:", typeof res.messages);
      console.log("Messages is array:", Array.isArray(res.messages));
    } else if (Array.isArray(res.messages)) {
      // Detailed message analysis
      const messagesWithDetails = res.messages.map((msg: unknown, idx: number) => {
        const m = msg as Record<string, unknown>;
        const hasEmptyContent = Array.isArray(m.content) && m.content.length === 0;
        const contentValue = m.content;
        const contentStr = typeof contentValue === "string" 
          ? (contentValue.length > 100 ? contentValue.substring(0, 100) + "..." : contentValue)
          : Array.isArray(contentValue)
          ? `[Array(${contentValue.length})]`
          : contentValue;
        
        return {
          index: idx,
          role: m.role,
          hasContent: !!m.content,
          contentType: typeof m.content,
          contentIsArray: Array.isArray(m.content),
          contentLength: Array.isArray(m.content) ? m.content.length : typeof m.content === "string" ? m.content.length : "N/A",
          hasEmptyContent,
          contentPreview: contentStr,
          allKeys: Object.keys(m),
          fullMessage: JSON.parse(JSON.stringify(m)),
        };
      });
      
      console.log("📋 All message details:", messagesWithDetails);
      
      const emptyContentCount = messagesWithDetails.filter((m) => m.hasEmptyContent).length;
      if (emptyContentCount > 0) {
        console.warn(`⚠️ ${emptyContentCount}/${messageCount} messages have empty content arrays`);
        const emptyMessages = res.messages.filter((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return Array.isArray(m.content) && m.content.length === 0;
        });
        
        // Log empty messages with context about when they might have been created
        console.log("🚨 Messages with empty content (full structure):", emptyMessages.map((msg: unknown) => JSON.parse(JSON.stringify(msg))));
        console.log("🔍 Empty message analysis:", emptyMessages.map((msg: unknown, idx: number) => {
          const m = msg as Record<string, unknown>;
          const timestamp = m.timestamp;
          const timestampDate = typeof timestamp === "number" ? new Date(timestamp).toISOString() : "unknown";
          const ageMs = typeof timestamp === "number" ? Date.now() - timestamp : null;
          const ageSec = ageMs !== null ? Math.round(ageMs / 1000) : null;
          
          return {
            index: idx,
            role: m.role,
            timestamp: timestamp,
            timestampISO: timestampDate,
            ageSeconds: ageSec,
            stopReason: m.stopReason,
            errorMessage: m.errorMessage,
            toolCalls: m.toolCalls,
            toolResults: m.toolResults,
            allProperties: Object.keys(m),
            propertyTypes: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v])),
            fullMessage: JSON.parse(JSON.stringify(m)),
          };
        }));
        
        // Log correlation info: these messages were stored but have empty content
        // This suggests the model API response might have been empty or not properly captured
        console.warn(`[MODEL_API] Correlation: ${emptyContentCount} assistant messages with empty content arrays detected.`);
        console.warn(`[MODEL_API] This may indicate:`);
        console.warn(`  - Model API returned empty response`);
        console.warn(`  - Response was not properly captured/stored`);
        console.warn(`  - Message was created before content was populated`);
        console.warn(`  - Check backend [MODEL_API] logs for corresponding request/response`);
      }
      
      // Log non-empty messages for comparison with timestamps
      const nonEmptyMessages = res.messages.filter((msg: unknown) => {
        const m = msg as Record<string, unknown>;
        return !(Array.isArray(m.content) && m.content.length === 0);
      });
      if (nonEmptyMessages.length > 0) {
        console.log("✅ Messages with content (for comparison):", nonEmptyMessages.map((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          const timestamp = m.timestamp;
          const timestampDate = typeof timestamp === "number" ? new Date(timestamp).toISOString() : "unknown";
          
          return {
            role: m.role,
            timestamp: timestamp,
            timestampISO: timestampDate,
            contentLength: Array.isArray(m.content) ? m.content.length : typeof m.content === "string" ? m.content.length : "N/A",
            contentType: typeof m.content,
            contentPreview: Array.isArray(m.content) 
              ? m.content.slice(0, 2).map((c: unknown) => {
                  const block = c as Record<string, unknown>;
                  return { type: block.type, hasText: !!block.text, hasSource: !!block.source };
                })
              : typeof m.content === "string"
              ? m.content.substring(0, 50)
              : "unknown",
          };
        }));
      }
      
      // Log message timeline to help correlate with backend [MODEL_API] logs
      if (Array.isArray(res.messages) && res.messages.length > 0) {
        const timeline = res.messages.map((msg: unknown, idx: number) => {
          const m = msg as Record<string, unknown>;
          const timestamp = m.timestamp;
          const timestampDate = typeof timestamp === "number" ? new Date(timestamp).toISOString() : "unknown";
          const hasContent = Array.isArray(m.content) ? m.content.length > 0 : !!m.content;
          
          return {
            index: idx,
            role: m.role,
            timestamp: timestamp,
            timestampISO: timestampDate,
            hasContent,
            contentLength: Array.isArray(m.content) ? m.content.length : typeof m.content === "string" ? m.content.length : 0,
          };
        });
        console.log("📅 Message timeline (to correlate with backend [MODEL_API] logs):", timeline);
      }
    }
    
    console.groupEnd();
    
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    console.error("❌ loadChatHistory error:", err);
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], content: match[2] };
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) return false;

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  
  // Log streaming state initialization
  console.log(`[MODEL_API] Streaming state initialized:`, {
    runId,
    chatStream: state.chatStream,
    chatStreamStartedAt: new Date(state.chatStreamStartedAt).toISOString(),
    chatRunId: state.chatRunId,
  });

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) return null;
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  // Log send request to correlate with backend [MODEL_API] logs
  console.group(`%c[API] chat.send`, "color: #4CAF50; font-weight: bold");
  console.log("📤 Sending message:", {
    sessionKey: state.sessionKey,
    runId,
    messageLength: msg.length,
    hasAttachments: hasAttachments,
    attachmentCount: attachments?.length ?? 0,
    timestamp: new Date().toISOString(),
  });
  
  // Log the actual user input/prompt prominently to correlate with backend logs
  console.log(`[MODEL_API] User input/prompt: "${msg}"`);
  console.log(`[MODEL_API] This prompt will be sent to model provider: ${state.sessionKey}`);
  console.log(`[MODEL_API] Backend should log: [MODEL_API] Last user message (index X): "${msg}"`);
  
  if (hasAttachments && attachments) {
    console.log(`[MODEL_API] Attachments:`, attachments.map(att => ({
      type: att.type,
      mimeType: att.mimeType,
      fileName: att.fileName,
      dataLength: att.dataUrl?.length ?? 0,
    })));
  }
  
  try {
    const sendStartTime = Date.now();
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    const sendDuration = Date.now() - sendStartTime;
    console.log(`✅ Send request succeeded (${sendDuration}ms)`);
    console.log(`[MODEL_API] Frontend: chat.send completed, backend should process and call model API`);
    console.log(`[MODEL_API] Look for backend logs with runId=${runId} and sessionKey=${state.sessionKey}`);
    console.log(`[MODEL_API] Expected backend log: [MODEL_API] streamFn called: provider=... model=...`);
    console.log(`[MODEL_API] Expected backend log: [MODEL_API] Last user message (index X): "${msg}"`);
    console.groupEnd();
    return true;
  } catch (err) {
    const error = String(err);
    console.error(`❌ Send request failed:`, err);
    console.error(`[MODEL_API] Frontend: chat.send failed, model API call may not have been triggered`);
    console.groupEnd();
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (
    payload.runId &&
    state.chatRunId &&
    payload.runId !== state.chatRunId
  ) {
    if (payload.state === "final") {
      console.log(`[MODEL_API] Streaming: Received final event from different run (runId=${payload.runId}, currentRunId=${state.chatRunId})`);
      return "final";
    }
    return null;
  }

  // Log streaming events to correlate with backend [MODEL_API] logs
  const isOwnRun = payload.runId === state.chatRunId;
  const streamAge = state.chatStreamStartedAt ? Date.now() - state.chatStreamStartedAt : null;
  
  if (payload.state === "delta") {
    // Log raw delta payload for debugging
    if (isOwnRun && !state.chatStream) {
      console.group(`%c[MODEL_API] Delta received (first)`, "color: #FF9800; font-weight: bold");
      console.log(`runId: ${payload.runId}`);
      console.log(`sessionKey: ${payload.sessionKey}`);
      console.log(`rawPayload:`, JSON.parse(JSON.stringify(payload)));
      console.log(`message structure:`, payload.message);
      console.groupEnd();
    }
    
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      const isNewContent = !current || next.length >= current.length;
      
      // Log delta events (but throttle to avoid spam)
      if (isOwnRun && (next.length % 100 === 0 || next.length - current.length > 50)) {
        console.log(`[MODEL_API] Streaming delta: runId=${payload.runId} length=${next.length} chars age=${streamAge ? Math.round(streamAge / 1000) + "s" : "unknown"}`);
      }
      
      if (isNewContent) {
        state.chatStream = next;
        
        // Log first delta to confirm streaming started
        if (!current && isOwnRun) {
          console.group(`%c[MODEL_API] Streaming started`, "color: #FF9800; font-weight: bold");
          console.log(`runId: ${payload.runId}`);
          console.log(`sessionKey: ${payload.sessionKey}`);
          console.log(`timestamp: ${new Date().toISOString()}`);
          console.log(`firstChunk: "${next.substring(0, 100)}${next.length > 100 ? "..." : ""}"`);
          console.log(`firstChunkLength: ${next.length} chars`);
          console.log(`[MODEL_API] This corresponds to backend [MODEL_API] Response received logs`);
          console.groupEnd();
        }
      } else {
        // Log when content is not growing (potential issue)
        if (isOwnRun && current && next.length < current.length) {
          console.warn(`[MODEL_API] Streaming delta: content decreased! current=${current.length} next=${next.length}`);
        }
      }
    } else {
      // Log when delta doesn't contain extractable text - THIS IS A PROBLEM
      if (isOwnRun) {
        console.error(`[MODEL_API] ⚠️ CRITICAL: Delta does not contain extractable text!`, {
          runId: payload.runId,
          message: payload.message,
          messageType: typeof payload.message,
          messageKeys: payload.message && typeof payload.message === "object" ? Object.keys(payload.message) : [],
          extractedText: next,
          extractTextReturnType: typeof next,
        });
        console.error(`[MODEL_API] This may indicate the streaming payload structure is unexpected`);
        console.error(`[MODEL_API] Check backend logs for [MODEL_API] Response payload preview`);
      }
    }
  } else if (payload.state === "final") {
    const finalText = state.chatStream ?? "";
    const finalDuration = streamAge ? Math.round(streamAge / 1000) : null;
    const receivedAnyDeltas = finalText.length > 0;
    
    console.group(`%c[MODEL_API] Streaming final`, "color: #4CAF50; font-weight: bold");
    console.log(`runId: ${payload.runId}`);
    console.log(`sessionKey: ${payload.sessionKey}`);
    console.log(`duration: ${finalDuration ? finalDuration + "s" : "unknown"}`);
    console.log(`finalLength: ${finalText.length} chars`);
    console.log(`receivedAnyDeltas: ${receivedAnyDeltas}`);
    
    // CRITICAL: Check if we received any deltas at all
    if (!receivedAnyDeltas && isOwnRun) {
      console.error(`[MODEL_API] ⚠️ CRITICAL: NO DELTAS RECEIVED!`);
      console.error(`[MODEL_API] Stream length is 0, meaning no delta events were processed`);
      console.error(`[MODEL_API] Possible causes:`);
      console.error(`  1. Backend did not send any delta events`);
      console.error(`  2. Delta events were sent but extractText() returned empty`);
      console.error(`  3. Delta events were filtered out or not matching runId`);
      console.error(`[MODEL_API] Check backend logs for [MODEL_API] Response received`);
      console.error(`[MODEL_API] Check if backend sent delta events via emitChatDelta`);
    }
    
    console.log(`finalPreview: "${finalText.substring(0, 200)}${finalText.length > 200 ? "..." : ""}"`);
    
    // Analyze final message structure
    if (payload.message) {
      const msg = payload.message as Record<string, unknown>;
      const content = msg.content;
      const hasContent = Array.isArray(content) ? content.length > 0 : !!content;
      const contentLength = Array.isArray(content) ? content.length : typeof content === "string" ? content.length : 0;
      
      console.log(`finalMessage structure:`, {
        role: msg.role,
        hasContent,
        contentType: typeof content,
        contentIsArray: Array.isArray(content),
        contentLength,
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
        allKeys: Object.keys(msg),
      });
      
      // Log full message structure for debugging
      console.log(`[MODEL_API] Full final message payload:`, JSON.parse(JSON.stringify(msg)));
      
      // Extract and log content details
      if (Array.isArray(content)) {
        console.log(`[MODEL_API] Content array details:`, {
          length: content.length,
          items: content.map((item: unknown, idx: number) => {
            const itemAny = item as Record<string, unknown>;
            return {
              index: idx,
              type: itemAny.type,
              hasText: typeof itemAny.text === "string",
              textLength: typeof itemAny.text === "string" ? itemAny.text.length : 0,
              textPreview: typeof itemAny.text === "string" ? itemAny.text.substring(0, 100) : undefined,
              keys: Object.keys(itemAny),
            };
          }),
        });
      } else if (typeof content === "string") {
        console.log(`[MODEL_API] Content string: length=${content.length} preview="${content.substring(0, 200)}"`);
      }
      
      // Check if final message has empty content (this is the problem we're debugging)
      if (Array.isArray(content) && content.length === 0) {
        console.error(`[MODEL_API] ⚠️ FINAL MESSAGE HAS EMPTY CONTENT ARRAY!`);
        console.error(`[MODEL_API] Stream text length: ${finalText.length}`);
        console.error(`[MODEL_API] This indicates:`);
        if (finalText.length === 0) {
          console.error(`  - No deltas were received OR extractText() failed to extract content`);
          console.error(`  - Backend may have sent deltas but they weren't processed correctly`);
        } else {
          console.error(`  - Deltas were received (${finalText.length} chars) but final message has empty content`);
          console.error(`  - Content was streamed but not captured in final message structure`);
        }
        console.error(`[MODEL_API] Check backend logs for runId=${payload.runId}`);
        console.error(`[MODEL_API] Look for: [MODEL_API] Response received and emitChatDelta calls`);
        console.error(`[MODEL_API] Full final message:`, JSON.parse(JSON.stringify(msg)));
      } else if (Array.isArray(content) && content.length > 0 && finalText.length === 0) {
        console.warn(`[MODEL_API] ⚠️ Content array has ${content.length} items but stream text is empty`);
        console.warn(`[MODEL_API] This suggests content was in final payload but not streamed via deltas`);
      }
    } else {
      console.error(`[MODEL_API] ⚠️ Final payload has no message property!`);
      console.error(`[MODEL_API] Full payload:`, JSON.parse(JSON.stringify(payload)));
    }
    
    console.log(`[MODEL_API] Streaming complete, message should be stored in session`);
    console.log(`[MODEL_API] Call chat.history to verify message was stored correctly`);
    console.groupEnd();
    
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    console.warn(`[MODEL_API] Streaming aborted: runId=${payload.runId} duration=${streamAge ? Math.round(streamAge / 1000) + "s" : "unknown"}`);
    console.warn(`[MODEL_API] Model API call may have been cancelled`);
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    const errorMsg = payload.errorMessage ?? "chat error";
    console.error(`[MODEL_API] Streaming error: runId=${payload.runId} duration=${streamAge ? Math.round(streamAge / 1000) + "s" : "unknown"}`);
    console.error(`[MODEL_API] Error message: ${errorMsg}`);
    console.error(`[MODEL_API] Check backend [MODEL_API] Error logs for runId=${payload.runId}`);
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = errorMsg;
  }
  return payload.state;
}
