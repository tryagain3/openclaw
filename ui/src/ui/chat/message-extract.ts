import { stripThinkingTags } from "../format";

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

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

// Track how many times we've logged to avoid spam
let extractTextDebugCount = 0;
const MAX_EXTRACT_DEBUG_LOGS = 10; // Increased to see more examples

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  
  // Debug: log extraction attempts for first few messages
  const shouldDebug = extractTextDebugCount < MAX_EXTRACT_DEBUG_LOGS;
  
  if (typeof content === "string") {
    const processed = role === "assistant" ? stripThinkingTags(content) : stripEnvelope(content);
    if (shouldDebug) {
      extractTextDebugCount++;
      console.log(`[extractText] String content (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS}):`, {
        role,
        contentLength: content.length,
        processedLength: processed?.length ?? 0,
        wasEmpty: !processed,
      });
    }
    return processed || null;
  }
  
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        // Handle standard format: { type: "text", text: "..." }
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        // Handle case where item itself might be a string
        if (typeof item === "string") {
          return item;
        }
        // Handle case where content is directly a string in array
        if (typeof p === "string") {
          return p;
        }
        // Handle OpenAI format: { type: "text", content: "..." }
        if (item.type === "text" && typeof item.content === "string") {
          return item.content;
        }
        return null;
      })
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    
    if (shouldDebug && parts.length === 0) {
      extractTextDebugCount++;
      console.group(`%c[extractText] Array content empty (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS})`, "color: #FF9800; font-weight: bold");
      console.log("Role:", role);
      console.log("Content array:", content);
      console.log("Content items:", content.map((item: unknown, i: number) => {
        const it = item as Record<string, unknown>;
        return {
          index: i,
          type: it.type,
          keys: Object.keys(it),
          text: it.text,
          content: it.content,
          textType: typeof it.text,
          textLength: typeof it.text === "string" ? it.text.length : 0,
          textPreview: typeof it.text === "string" ? it.text.substring(0, 50) : undefined,
        };
      }));
      console.log("Why extraction failed: No items with type='text' and text property found");
      console.groupEnd();
    }
    
    if (shouldDebug && parts.length > 0) {
      extractTextDebugCount++;
      console.log(`[extractText] Array content extracted (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS}):`, {
        role,
        partsCount: parts.length,
        joinedLength: parts.join("\n").length,
      });
    }
    
    if (parts.length > 0) {
      const joined = parts.join("\n");
      const processed = role === "assistant" ? stripThinkingTags(joined) : stripEnvelope(joined);
      if (shouldDebug && !processed) {
        extractTextDebugCount++;
        console.log(`[extractText] Array content was empty after processing (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS}):`, { role, parts, joined });
      }
      return processed || null;
    }
  }
  
  if (typeof m.text === "string") {
    const processed = role === "assistant" ? stripThinkingTags(m.text) : stripEnvelope(m.text);
    if (shouldDebug) {
      extractTextDebugCount++;
      console.log(`[extractText] Text property (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS}):`, {
        role,
        textLength: m.text.length,
        processedLength: processed?.length ?? 0,
      });
    }
    return processed || null;
  }
  
  if (shouldDebug) {
    extractTextDebugCount++;
    console.groupCollapsed(`%c[extractText] No text found (${extractTextDebugCount}/${MAX_EXTRACT_DEBUG_LOGS})`, "color: #F44336; font-weight: bold");
    console.log("Message structure:", {
      role,
      hasContent: !!content,
      contentType: typeof content,
      contentIsArray: Array.isArray(content),
      contentLength: Array.isArray(content) ? content.length : "N/A",
      hasText: !!m.text,
      textType: typeof m.text,
    });
    console.log("Full message:", JSON.parse(JSON.stringify(message)));
    console.groupEnd();
  }
  
  return null;
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractText(message);
  const obj = message as object;
  if (textCache.has(obj)) return textCache.get(obj) ?? null;
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

export function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) parts.push(cleaned);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) return null;
  const matches = [
    ...rawText.matchAll(
      /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi,
    ),
  ];
  const extracted = matches
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractThinking(message);
  const obj = message as object;
  if (thinkingCache.has(obj)) return thinkingCache.get(obj) ?? null;
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

export function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}
