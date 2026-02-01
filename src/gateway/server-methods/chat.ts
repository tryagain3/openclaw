import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import { stripEnvelopeFromMessages } from "../chat-sanitize.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): string | null {
  const { sessionId, storePath, sessionFile } = params;
  if (sessionFile) return sessionFile;
  if (!storePath) return null;
  return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) return { ok: true };
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const messageBody: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    stopReason: "injected",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  // #region agent log
  fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:133',message:'appendAssistantTranscriptMessage writing to file',data:{transcriptPath,messageBody:{role:messageBody.role,contentLength:Array.isArray(messageBody.content)?messageBody.content.length:'N/A',hasContent:!!messageBody.content,contentIsArray:Array.isArray(messageBody.content)}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'WRITE'})}).catch(()=>{});
  // #endregion

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: params.message,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:185',message:'chat.history request received',data:{params:JSON.parse(JSON.stringify(params))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'REQUEST'})}).catch(()=>{});
    // #endregion
    
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    
    // #region agent log - STEP 1: loadSessionEntry INPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:209',message:'STEP1 loadSessionEntry INPUT',data:{sessionKey},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP1_IN'})}).catch(()=>{});
    // #endregion
    
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    
    // #region agent log - STEP 1: loadSessionEntry OUTPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:212',message:'STEP1 loadSessionEntry OUTPUT',data:{sessionId:sessionId??'none',hasStorePath:!!storePath,hasEntry:!!entry,sessionFile:entry?.sessionFile??'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP1_OUT'})}).catch(()=>{});
    // #endregion
    
    context.logGateway.info(
      `[CHAT.HISTORY] Loading: sessionKey=${sessionKey} sessionId=${sessionId ?? "none"} storePath=${storePath ?? "none"} sessionFile=${entry?.sessionFile ?? "none"}`,
    );
    
    // #region agent log - STEP 2: readSessionMessages INPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:217',message:'STEP2 readSessionMessages INPUT',data:{sessionId:sessionId??'none',hasStorePath:!!storePath,sessionFile:entry?.sessionFile??'none',willCall:!!(sessionId&&storePath)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP2_IN'})}).catch(()=>{});
    // #endregion
    
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    
    // #region agent log - STEP 2: readSessionMessages OUTPUT
    const rawEmptyCount = rawMessages.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:220',message:'STEP2 readSessionMessages OUTPUT',data:{count:rawMessages.length,emptyContentCount:rawEmptyCount,allMessages:rawMessages.map((msg:unknown,idx:number)=>{const m=msg as Record<string,unknown>;return{index:idx,role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A',contentValue:Array.isArray(m.content)?JSON.stringify(m.content).substring(0,100):String(m.content).substring(0,100)}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP2_OUT'})}).catch(()=>{});
    // #endregion
    
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:208',message:'rawMessages after readSessionMessages',data:{count:rawMessages.length,emptyContentCount:rawMessages.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length,sampleMessages:rawMessages.slice(0,3).map((msg:unknown)=>{const m=msg as Record<string,unknown>;return{role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A'}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    // Check for empty content arrays in raw messages
    const emptyContentMessages = rawMessages.filter((msg) => {
      const m = msg as Record<string, unknown>;
      return (
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.length === 0
      );
    });
    
    if (emptyContentMessages.length > 0) {
      context.logGateway.warn(
        `[CHAT.HISTORY] Found ${emptyContentMessages.length} assistant messages with empty content arrays`,
      );
      // Log sample of empty messages
      const sample = emptyContentMessages.slice(0, 3).map((msg) => {
        const m = msg as Record<string, unknown>;
        return {
          role: m.role,
          timestamp: m.timestamp,
          hasContent: Array.isArray(m.content),
          contentLength: Array.isArray(m.content) ? m.content.length : 0,
          stopReason: m.stopReason,
          errorMessage: m.errorMessage,
          allKeys: Object.keys(m),
        };
      });
      context.logGateway.warn(
        `[CHAT.HISTORY] Sample empty messages: ${JSON.stringify(sample, null, 2)}`,
      );
    }
    
    context.logGateway.info(
      `[CHAT.HISTORY] Raw messages: count=${rawMessages.length} hasSessionId=${!!sessionId} hasStorePath=${!!storePath} emptyContentCount=${emptyContentMessages.length}`,
    );
    
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    
    // #region agent log - STEP 3: slice INPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:263',message:'STEP3 slice INPUT',data:{rawMessagesCount:rawMessages.length,max,hardMax,defaultLimit,requested,willSlice:rawMessages.length>max},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP3_IN'})}).catch(()=>{});
    // #endregion
    
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    
    // #region agent log - STEP 3: slice OUTPUT
    const slicedEmptyCount = sliced.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:266',message:'STEP3 slice OUTPUT',data:{count:sliced.length,emptyContentCount:slicedEmptyCount,allMessages:sliced.map((msg:unknown,idx:number)=>{const m=msg as Record<string,unknown>;return{index:idx,role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A',contentValue:Array.isArray(m.content)?JSON.stringify(m.content).substring(0,100):String(m.content).substring(0,100)}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP3_OUT'})}).catch(()=>{});
    // #endregion
    
    // #region agent log - STEP 4: stripEnvelopeFromMessages INPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:269',message:'STEP4 stripEnvelopeFromMessages INPUT',data:{slicedCount:sliced.length,emptyContentCount:slicedEmptyCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP4_IN'})}).catch(()=>{});
    // #endregion
    
    const sanitized = stripEnvelopeFromMessages(sliced);
    
    // #region agent log - STEP 4: stripEnvelopeFromMessages OUTPUT
    const sanitizedEmptyCount = sanitized.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:272',message:'STEP4 stripEnvelopeFromMessages OUTPUT',data:{count:sanitized.length,emptyContentCount:sanitizedEmptyCount,changed:sanitized!==sliced,allMessages:sanitized.map((msg:unknown,idx:number)=>{const m=msg as Record<string,unknown>;return{index:idx,role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A',contentValue:Array.isArray(m.content)?JSON.stringify(m.content).substring(0,100):String(m.content).substring(0,100)}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP4_OUT'})}).catch(()=>{});
    // #endregion
    
    const maxBytes = getMaxChatHistoryMessagesBytes();
    
    // #region agent log - STEP 5: capArrayByJsonBytes INPUT
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:275',message:'STEP5 capArrayByJsonBytes INPUT',data:{sanitizedCount:sanitized.length,emptyContentCount:sanitizedEmptyCount,maxBytes},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP5_IN'})}).catch(()=>{});
    // #endregion
    
    const capped = capArrayByJsonBytes(sanitized, maxBytes).items;
    
    // #region agent log - STEP 5: capArrayByJsonBytes OUTPUT
    const cappedEmptyCount = capped.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:278',message:'STEP5 capArrayByJsonBytes OUTPUT',data:{count:capped.length,emptyContentCount:cappedEmptyCount,removed:capped.length!==sanitized.length,allMessages:capped.map((msg:unknown,idx:number)=>{const m=msg as Record<string,unknown>;return{index:idx,role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A',contentValue:Array.isArray(m.content)?JSON.stringify(m.content).substring(0,100):String(m.content).substring(0,100)}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP5_OUT'})}).catch(()=>{});
    // #endregion
    
    context.logGateway.info(
      `[CHAT.HISTORY] Processed: sliced=${sliced.length} sanitized=${sanitized.length} capped=${capped.length}`,
    );
    
    // Resolve model info once for both thinkingLevel and response
    const { provider, model } = resolveSessionModelRef(cfg, entry);
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const modelResolved = resolveModel(provider, model, agentId, cfg);
    const modelBaseUrl = modelResolved.model?.baseUrl;
    const modelApi = modelResolved.model?.api;
    
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agents?.defaults?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    
    context.logGateway.info(
      `[MODEL] chat.history: provider=${provider} model=${model} baseUrl=${modelBaseUrl ?? "default"} api=${modelApi ?? "unknown"} sessionKey=${sessionKey} messageCount=${capped.length}`,
    );
    
    // #region agent log - STEP 6: respond INPUT
    const finalEmptyCount = capped.filter((msg:unknown)=>{const m=msg as Record<string,unknown>;return m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0}).length;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat.ts:313',message:'STEP6 respond INPUT',data:{count:capped.length,emptyContentCount:finalEmptyCount,thinkingLevel,provider,model,modelBaseUrl,modelApi,allMessages:capped.map((msg:unknown,idx:number)=>{const m=msg as Record<string,unknown>;return{index:idx,role:m.role,hasContent:!!m.content,contentType:typeof m.content,contentIsArray:Array.isArray(m.content),contentLength:Array.isArray(m.content)?m.content.length:'N/A',contentValue:Array.isArray(m.content)?JSON.stringify(m.content).substring(0,100):String(m.content).substring(0,100)}})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STEP6_IN'})}).catch(()=>{});
    // #endregion
    
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
      modelProvider: provider,
      modelId: model,
      modelBaseUrl: modelBaseUrl ?? undefined,
      modelApi: modelApi ?? undefined,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = {
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      chatDeltaSentAt: context.chatDeltaSentAt,
      chatAbortedRuns: context.chatAbortedRuns,
      removeChatRun: context.removeChatRun,
      agentRunSeq: context.agentRunSeq,
      broadcast: context.broadcast,
      nodeSendToSession: context.nodeSendToSession,
    };

    if (!runId) {
      const res = abortChatRunsForSessionKey(ops, {
        sessionKey,
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const res = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const stopCommand = isChatStopCommandText(p.message);
    const normalizedAttachments =
      p.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content:
            typeof a?.content === "string"
              ? a.content
              : ArrayBuffer.isView(a?.content)
                ? Buffer.from(
                    a.content.buffer,
                    a.content.byteOffset,
                    a.content.byteLength,
                  ).toString("base64")
                : undefined,
        }))
        .filter((a) => a.content) ?? [];
    const rawMessage = p.message.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    
    // Log the incoming user message
    context.logGateway.info(
      `[CHAT.SEND] User message: sessionKey=${p.sessionKey} message="${rawMessage.substring(0, 200)}${rawMessage.length > 200 ? "..." : ""}" attachments=${normalizedAttachments.length}`,
    );
    
    let parsedMessage = p.message;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(p.message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
        context.logGateway.info(
          `[CHAT.SEND] Parsed message: text="${parsedMessage.substring(0, 200)}${parsedMessage.length > 200 ? "..." : ""}" images=${parsedImages.length}`,
        );
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const { cfg, entry } = loadSessionEntry(p.sessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKey(
        {
          chatAbortControllers: context.chatAbortControllers,
          chatRunBuffers: context.chatRunBuffers,
          chatDeltaSentAt: context.chatDeltaSentAt,
          chatAbortedRuns: context.chatAbortedRuns,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
        },
        { sessionKey: p.sessionKey, stopReason: "stop" },
      );
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: p.sessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });

      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: parsedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: p.sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
      };

      const agentId = resolveSessionAgentId({
        sessionKey: p.sessionKey,
        config: cfg,
      });
      
      // Resolve model to get baseUrl for logging
      const { provider, model } = resolveSessionModelRef(cfg, entry);
      const modelResolved = resolveModel(provider, model, agentId, cfg);
      const modelBaseUrl = modelResolved.model?.baseUrl;
      const modelApi = modelResolved.model?.api;
      
      context.logGateway.info(
        `[MODEL] chat.send: provider=${provider} model=${model} baseUrl=${modelBaseUrl ?? "default"} api=${modelApi ?? "unknown"} sessionKey=${p.sessionKey}`,
      );
      
      let prefixContext: ResponsePrefixContext = {
        identityName: resolveIdentityName(cfg, agentId),
      };
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
        responsePrefixContextProvider: () => prefixContext,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") return;
          const text = payload.text?.trim() ?? "";
          if (!text) return;
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          disableBlockStreaming: true,
          onAgentRunStart: () => {
            agentRunStarted = true;
          },
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
            
            // Log actual model selected (may differ from initial resolve due to fallbacks)
            const selectedModelResolved = resolveModel(ctx.provider, ctx.model, agentId, cfg);
            const selectedBaseUrl = selectedModelResolved.model?.baseUrl;
            const selectedApi = selectedModelResolved.model?.api;
            context.logGateway.info(
              `[MODEL] Selected: provider=${ctx.provider} model=${ctx.model} baseUrl=${selectedBaseUrl ?? "default"} api=${selectedApi ?? "unknown"}`,
            );
          },
        },
      })
        .then(() => {
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                p.sessionKey,
              );
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message,
            });
          }
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            },
            error,
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: p.sessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const { storePath, entry } = loadSessionEntry(p.sessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    // Resolve transcript path
    const transcriptPath = entry?.sessionFile
      ? entry.sessionFile
      : path.join(path.dirname(storePath), `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "transcript file not found"),
      );
      return;
    }

    // Build transcript entry
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const labelPrefix = p.label ? `[${p.label}]\n\n` : "";
    const messageBody: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: `${labelPrefix}${p.message}` }],
      timestamp: now,
      stopReason: "injected",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${errMessage}`),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${messageId}`,
      sessionKey: p.sessionKey,
      seq: 0,
      state: "final" as const,
      message: transcriptEntry.message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId });
  },
};
