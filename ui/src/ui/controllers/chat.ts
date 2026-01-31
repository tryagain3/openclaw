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

export async function loadChatHistory(state: ChatState) {
  const timestamp = new Date().toISOString();
  console.group(`%c[CHAT] loadChatHistory ${timestamp}`, "color: #2196F3; font-weight: bold");
  console.log("State:", {
    hasClient: !!state.client,
    connected: state.connected,
    sessionKey: state.sessionKey,
  });
  
  if (!state.client || !state.connected) {
    console.warn("⚠️ Skipped: no client or not connected");
    console.groupEnd();
    return;
  }
  
  state.chatLoading = true;
  state.lastError = null;
  try {
    const requestParams = {
      sessionKey: state.sessionKey,
      limit: 200,
    };
    
    console.group(`%c[API] chat.history request`, "color: #2196F3; font-weight: bold");
    console.log("Request params:", requestParams);
    console.log("Client state:", {
      hasClient: !!state.client,
      connected: state.connected,
      clientConnected: state.client?.connected ?? false,
    });
    
    const requestStartTime = Date.now();
    let res: { messages?: unknown[]; thinkingLevel?: string | null };
    let requestError: unknown = null;
    
    try {
      res = (await state.client.request("chat.history", requestParams)) as {
        messages?: unknown[];
        thinkingLevel?: string | null;
      };
      const requestDuration = Date.now() - requestStartTime;
      console.log(`✅ Request succeeded (${requestDuration}ms)`);
    } catch (err) {
      requestError = err;
      const requestDuration = Date.now() - requestStartTime;
      console.error(`❌ Request failed after ${requestDuration}ms:`, err);
      console.error("Error details:", {
        name: err instanceof Error ? err.name : "Unknown",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        errorType: typeof err,
        errorString: String(err),
      });
      throw err;
    }
    
    const requestDuration = Date.now() - requestStartTime;
    
    console.group(`%c[API] chat.history response`, "color: #4CAF50; font-weight: bold");
    console.log("Response received:", {
      duration: `${requestDuration}ms`,
      responseType: typeof res,
      responseIsObject: res !== null && typeof res === "object",
      responseKeys: res !== null && typeof res === "object" ? Object.keys(res) : [],
      responseStringified: JSON.stringify(res).substring(0, 500),
    });
    
    // Validate response structure
    if (!res || typeof res !== "object") {
      console.error("❌ Invalid response: not an object", {
        res,
        resType: typeof res,
        resIsNull: res === null,
        resIsUndefined: res === undefined,
      });
      throw new Error(`Invalid response from chat.history: expected object, got ${typeof res}`);
    }
    
    const messageCount = Array.isArray(res.messages) ? res.messages.length : 0;
    const hasMessages = "messages" in res;
    const messagesIsArray = Array.isArray(res.messages);
    const thinkingLevel = res.thinkingLevel;
    
    console.log("Response structure:", {
      hasMessages,
      messagesIsArray,
      messageCount,
      thinkingLevel,
      thinkingLevelType: typeof thinkingLevel,
      allResponseKeys: Object.keys(res),
    });
    
    // Check for empty or problematic responses
    if (!hasMessages) {
      console.warn("⚠️ Response missing 'messages' property");
    } else if (!messagesIsArray) {
      console.error("❌ Response 'messages' is not an array", {
        messagesType: typeof res.messages,
        messagesValue: res.messages,
      });
    } else if (messageCount === 0) {
      console.warn("⚠️ Response has empty messages array");
      console.log("Full response:", JSON.parse(JSON.stringify(res)));
    }
    
    // Check for empty content arrays in messages
    if (messageCount > 0 && Array.isArray(res.messages)) {
      const emptyContentCount = res.messages.filter((msg: unknown) => {
        const m = msg as Record<string, unknown>;
        return Array.isArray(m.content) && m.content.length === 0;
      }).length;
      if (emptyContentCount > 0) {
        console.warn(`⚠️ Found ${emptyContentCount}/${messageCount} messages with empty content arrays`);
      }
    }
    
    console.groupEnd();
    console.groupEnd();
    
    console.log(`✅ chat.history response: ${messageCount} messages`, {
      messageCount,
      thinkingLevel: res.thinkingLevel,
      duration: `${requestDuration}ms`,
    });
    
    if (messageCount > 0 && Array.isArray(res.messages)) {
      try {
        const preview = res.messages.slice(0, 5).map((msg: unknown, i: number) => {
          const m = msg as Record<string, unknown>;
          const content = m.content;
          let contentType = "none";
          let contentLength = 0;
          if (typeof content === "string") {
            contentType = "string";
            contentLength = content.length;
          } else if (Array.isArray(content)) {
            contentType = "array";
            contentLength = content.length;
          }
          return {
            index: i,
            role: m.role ?? "unknown",
            hasContent: !!m.content,
            contentType,
            contentLength,
            timestamp: m.timestamp ?? "none",
          };
        });
        console.table(preview);
        
        // Log detailed content structure for first 3 messages
        console.group("📋 First 3 messages content structure");
        for (let i = 0; i < Math.min(3, res.messages.length); i++) {
          const msg = res.messages[i] as Record<string, unknown>;
          console.log(`Message ${i} (role: ${msg.role}):`, {
            content: msg.content,
            contentType: typeof msg.content,
            contentIsArray: Array.isArray(msg.content),
            contentArrayLength: Array.isArray(msg.content) ? msg.content.length : "N/A",
            contentArrayItems: Array.isArray(msg.content) 
              ? msg.content.map((item: unknown, idx: number) => {
                  const it = item as Record<string, unknown>;
                  return {
                    index: idx,
                    type: it.type,
                    keys: Object.keys(it),
                    text: it.text,
                    textType: typeof it.text,
                    textLength: typeof it.text === "string" ? it.text.length : 0,
                    textPreview: typeof it.text === "string" ? it.text.substring(0, 50) : undefined,
                  };
                })
              : "N/A",
          });
        }
        console.groupEnd();
        
        if (messageCount > 5) {
          console.log(`... and ${messageCount - 5} more messages`);
        }
      } catch (tableErr) {
        console.log("Message preview (table failed):", res.messages.slice(0, 3));
      }
    }
    
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    console.error("❌ loadChatHistory error:", err);
    console.error("Error details:", {
      name: err instanceof Error ? err.name : "Unknown",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
    console.groupEnd();
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

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return true;
  } catch (err) {
    const error = String(err);
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
    if (payload.state === "final") return "final";
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
