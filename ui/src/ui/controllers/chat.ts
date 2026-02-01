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
    
    if (modelProvider && modelId) {
      console.log("🤖 Model Provider:", {
        provider: modelProvider,
        model: modelId,
        baseUrl: modelBaseUrl ?? "default",
        api: modelApi ?? "unknown",
      });
    }
    
    // Validate response
    if (!res || typeof res !== "object") {
      console.error("❌ Invalid response: not an object", { res, resType: typeof res });
      console.groupEnd();
      throw new Error(`Invalid response: expected object, got ${typeof res}`);
    }
    
    if (!hasMessages) {
      console.warn("⚠️ Response missing 'messages' property");
      console.log("Full response:", JSON.parse(JSON.stringify(res)));
    } else if (!messagesIsArray) {
      console.error("❌ Response 'messages' is not an array", {
        messagesType: typeof res.messages,
        messagesValue: res.messages,
      });
    } else if (messageCount === 0) {
      console.warn("⚠️ Response has empty messages array");
      console.log("Full response:", JSON.parse(JSON.stringify(res)));
    } else if (Array.isArray(res.messages)) {
      // Check for empty content arrays and log details
      const messagesWithDetails = res.messages.map((msg: unknown, idx: number) => {
        const m = msg as Record<string, unknown>;
        const hasEmptyContent = Array.isArray(m.content) && m.content.length === 0;
        return {
          index: idx,
          role: m.role,
          hasContent: !!m.content,
          contentType: typeof m.content,
          contentIsArray: Array.isArray(m.content),
          contentLength: Array.isArray(m.content) ? m.content.length : "N/A",
          hasEmptyContent,
          allKeys: Object.keys(m),
        };
      });
      
      const emptyContentCount = messagesWithDetails.filter((m) => m.hasEmptyContent).length;
      if (emptyContentCount > 0) {
        console.warn(`⚠️ ${emptyContentCount}/${messageCount} messages have empty content arrays`);
        console.log("Message details:", messagesWithDetails);
        console.log("Messages with empty content:", res.messages.filter((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return Array.isArray(m.content) && m.content.length === 0;
        }).map((msg: unknown) => JSON.parse(JSON.stringify(msg))));
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
