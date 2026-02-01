const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) return text;
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) return text;
  return text.slice(match[0].length);
}

function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) return text;
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}

function stripEnvelopeFromContent(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") return item;
    const stripped = stripMessageIdHints(stripEnvelope(entry.text));
    if (stripped === entry.text) return item;
    changed = true;
    return {
      ...entry,
      text: stripped,
    };
  });
  return { content: next, changed };
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  
  // #region agent log - stripEnvelopeFromMessage INPUT
  if (role === "assistant") {
    const isEmpty = Array.isArray(entry.content) && entry.content.length === 0;
    fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat-sanitize.ts:61',message:'stripEnvelopeFromMessage INPUT assistant',data:{role,hasContent:!!entry.content,contentType:typeof entry.content,contentIsArray:Array.isArray(entry.content),contentLength:Array.isArray(entry.content)?entry.content.length:'N/A',isEmpty},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STRIP_IN'})}).catch(()=>{});
  }
  // #endregion
  
  if (role !== "user") {
    // #region agent log - stripEnvelopeFromMessage OUTPUT (no change for assistant)
    if (role === "assistant") {
      fetch('http://127.0.0.1:7244/ingest/2688fe74-68c1-4ff8-98aa-6bd3a43e9c22',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'chat-sanitize.ts:69',message:'stripEnvelopeFromMessage OUTPUT assistant (unchanged)',data:{role,changed:false,hasContent:!!entry.content,contentType:typeof entry.content,contentIsArray:Array.isArray(entry.content),contentLength:Array.isArray(entry.content)?entry.content.length:'N/A'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'STRIP_OUT'})}).catch(()=>{});
    }
    // #endregion
    return message;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  if (typeof entry.content === "string") {
    const stripped = stripMessageIdHints(stripEnvelope(entry.content));
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContent(entry.content);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripMessageIdHints(stripEnvelope(entry.text));
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? next : messages;
}
