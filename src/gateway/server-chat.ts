import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

/**
 * Check if webchat broadcasts should be suppressed for heartbeat runs.
 * Returns true if the run is a heartbeat and showOk is false.
 */
function shouldSuppressHeartbeatBroadcast(runId: string): boolean {
  const runContext = getAgentRunContext(runId);
  if (!runContext?.isHeartbeat) return false;

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) return undefined;
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  logGateway?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export function createAgentEventHandler({
  broadcast,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  logGateway,
}: AgentEventHandlerOptions) {
  // Use provided logger or fallback to console
  const log = logGateway ?? {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const emitChatDelta = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    chatRunState.buffers.set(clientRunId, text);
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) return;
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    // Suppress webchat broadcast for heartbeat runs when showOk is false
    if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
      broadcast("chat", payload, { dropIfSlow: true });
    }
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
  ) => {
    const bufferText = chatRunState.buffers.get(clientRunId);
    const text = bufferText?.trim() ?? "";
    const bufferHadContent = Boolean(bufferText && bufferText.trim().length > 0);
    
    // Log final emission to help debug empty content issues
    console.log(
      `[EMIT_FINAL] Emitting final: runId=${clientRunId} sessionKey=${sessionKey} seq=${seq} jobState=${jobState} bufferLength=${bufferText?.length ?? 0} bufferHadContent=${bufferHadContent} finalTextLength=${text.length}`,
    );
    
    if (!bufferHadContent && jobState === "done") {
      console.warn(
        `[EMIT_FINAL] ⚠️ WARNING: Final event with empty buffer! runId=${clientRunId} sessionKey=${sessionKey}`,
      );
      console.warn(
        `[EMIT_FINAL] This means no deltas were sent, so message property will be undefined`,
      );
      console.warn(
        `[EMIT_FINAL] Check if assistant stream events were received: evt.stream === "assistant" && typeof evt.data?.text === "string"`,
      );
    }
    
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message: text
          ? {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            }
          : undefined,
      };
      
      if (!text) {
        console.warn(
          `[EMIT_FINAL] Final payload will have undefined message property (buffer was empty)`,
        );
      }
      // Suppress webchat broadcast for heartbeat runs when showOk is false
      if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
        broadcast("chat", payload);
      }
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const shouldEmitToolEvents = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) return runVerbose === "on";
    if (!sessionKey) return false;
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) return sessionVerbose === "on";
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose === "on";
    } catch {
      return false;
    }
  };

  return (evt: AgentEventPayload) => {
    try {
      const chatLink = chatRunState.registry.peek(evt.runId);
      const sessionKey = chatLink?.sessionKey ?? resolveSessionKeyForRun(evt.runId);
      const clientRunId = chatLink?.clientRunId ?? evt.runId;
      const isAborted =
        chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...evt, sessionKey } : evt;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    if (evt.stream === "tool" && !shouldEmitToolEvents(evt.runId, sessionKey)) {
      agentRunSeq.set(evt.runId, evt.seq);
      return;
    }
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", agentPayload);

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    if (sessionKey) {
      nodeSendToSession(sessionKey, "agent", agentPayload);
      
      // Log all assistant stream events to debug why deltas might not be sent
      if (evt.stream === "assistant") {
        const hasText = typeof evt.data?.text === "string";
        const textLength = hasText && typeof evt.data.text === "string" ? evt.data.text.length : 0;
        log.info(
          `[EMIT_DELTA] Assistant stream event: runId=${evt.runId} clientRunId=${clientRunId} sessionKey=${sessionKey} seq=${evt.seq} isAborted=${isAborted} hasText=${hasText} textLength=${textLength} dataType=${typeof evt.data}`,
        );
        if (evt.data && typeof evt.data === "object") {
          const dataAny = evt.data as Record<string, unknown>;
          log.info(`[EMIT_DELTA] evt.data structure: ${JSON.stringify({
            keys: Object.keys(dataAny),
            textType: typeof dataAny.text,
            textLength: typeof dataAny.text === "string" ? dataAny.text.length : "N/A",
            deltaType: typeof dataAny.delta,
            hasDelta: "delta" in dataAny,
          })}`);
        }
      }
      
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        // Log delta emission to help debug empty content issues
        const textLength = evt.data.text.length;
        const textPreview = textLength > 100 ? evt.data.text.substring(0, 100) + "..." : evt.data.text;
        log.info(
          `[EMIT_DELTA] ✅ Sending delta: runId=${evt.runId} clientRunId=${clientRunId} sessionKey=${sessionKey} seq=${evt.seq} textLength=${textLength} preview="${textPreview}"`,
        );
        emitChatDelta(sessionKey, clientRunId, evt.seq, evt.data.text);
      } else if (!isAborted && evt.stream === "assistant") {
        // Log when assistant stream event doesn't trigger delta (for debugging)
        log.warn(
          `[EMIT_DELTA] ⚠️ Assistant stream event but NO delta sent: runId=${evt.runId} clientRunId=${clientRunId} sessionKey=${sessionKey} seq=${evt.seq}`,
        );
        log.warn(
          `[EMIT_DELTA] Condition check: isAborted=${isAborted} stream=${evt.stream} hasText=${typeof evt.data?.text === "string"}`,
        );
        if (evt.data && typeof evt.data === "object") {
          const dataAny = evt.data as Record<string, unknown>;
          log.warn(`[EMIT_DELTA] evt.data keys: ${Object.keys(dataAny).join(",")}`);
          log.warn(`[EMIT_DELTA] evt.data.text: ${JSON.stringify(dataAny.text)}`);
          log.warn(`[EMIT_DELTA] evt.data.delta: ${JSON.stringify(dataAny.delta)}`);
        }
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
          emitChatFinal(
            sessionKey,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      clearAgentRunContext(evt.runId);
    }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      log.error(
        `[EMIT_DELTA] ❌ Error in agent event handler: runId=${evt.runId} stream=${evt.stream} error="${errorMsg}"`,
      );
      if (errorStack) {
        log.error(`[EMIT_DELTA] Error stack: ${errorStack}`);
      }
      log.error(
        `[EMIT_DELTA] Event context: ${JSON.stringify({
          runId: evt.runId,
          stream: evt.stream,
          seq: evt.seq,
          dataKeys: evt.data && typeof evt.data === "object" ? Object.keys(evt.data) : [],
        })}`,
      );
      // Don't re-throw to prevent breaking the event stream, but log the error
    }
  };
}
