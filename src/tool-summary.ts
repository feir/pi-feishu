/**
 * Tool summary helpers for pi-feishu progress cards.
 * Pure functions — no side effects, no imports from feishu-client or Pi SDK.
 */

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const WHITESPACE_RE = /\s+/g;

/** Sanitize a string for safe rendering inside a Feishu markdown card:
 *  - collapse consecutive whitespace to single space
 *  - strip control characters
 *  - escape backticks to prevent markdown code-span breakage
 */
export function sanitize(s: string): string {
  return s
    .replace(CONTROL_RE, "")
    .replace(WHITESPACE_RE, " ")
    .replace(/`/g, "\\`")
    .trim();
}

// ─── Arg extractors ──────────────────────────────────────

type ArgExtractor = (args: Record<string, unknown> | undefined | null) => string;

function extractPathOrPattern(args: Record<string, unknown> | undefined | null): string {
  if (!args) return "";
  if (typeof args.path === "string") return args.path;
  if (typeof args.pattern === "string") return args.pattern;
  return "";
}

function extractAgent(args: Record<string, unknown> | undefined | null): string {
  if (!args) return "";
  if (typeof args.agent === "string") return args.agent;
  if (args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) return "(parallel)";
  return "";
}

const ARG_EXTRACTORS: Record<string, ArgExtractor> = {
  bash: (args) => (args && typeof args.command === "string" ? args.command : ""),
  read: extractPathOrPattern,
  edit: extractPathOrPattern,
  write: extractPathOrPattern,
  find: extractPathOrPattern,
  ls: extractPathOrPattern,
  grep: (args) => {
    if (!args) return "";
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const glob = typeof args.glob === "string" ? ` (${args.glob})` : "";
    return pattern ? pattern + glob : "";
  },
  subagent: extractAgent,
  agent: extractAgent,
};

/**
 * Summarize tool arguments into a short display string.
 * Returns empty string for missing/malformed args.
 * Max output length: 80 chars (after sanitize + "…" truncation).
 */
export function summarizeArgs(
  toolName: string,
  args: Record<string, unknown> | undefined | null,
): string {
  if (!args || typeof args !== "object") return "";

  const extractor = ARG_EXTRACTORS[toolName];
  let raw: string;

  if (extractor) {
    raw = extractor(args);
  } else {
    // Fallback: first string field
    const firstString = Object.values(args).find(
      (v): v is string => typeof v === "string",
    );
    raw = firstString ?? "";
  }

  if (!raw) return "";

  const cleaned = sanitize(raw);
  if (cleaned.length > 80) {
    return cleaned.slice(0, 80) + "…";
  }
  return cleaned;
}

/**
 * Extract text blocks from Pi tool result shape:
 *   { content: [{ type: "text", text: "..." }, ...], details?: any }
 * Returns joined text or empty string if shape doesn't match.
 */
function extractContentText(obj: Record<string, unknown>): string {
  const content = obj.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  // join with space — sanitize() strips \n as a control char, so "\n" would
  // produce visually concatenated text in the card. Use " " so multi-block
  // errors stay readable.
  return parts.join(" ");
}

/**
 * Extract a short error snippet from a tool result.
 * Handles Pi Core's AgentToolResult shape ({ content: [{type:"text", text}] })
 * which is the common form for failed built-in tools.
 * Max output: 200 chars (after sanitize + "…" truncation).
 */
export function errorSnippet(result: unknown, maxLen = 200): string {
  if (!result) return "";

  let text: string;

  if (typeof result === "string") {
    text = result;
  } else if (result instanceof Error) {
    text = result.message;
  } else if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    // Pi tool result shape comes first — most common case
    const fromContent = extractContentText(obj);
    if (fromContent) text = fromContent;
    else if (typeof obj.message === "string") text = obj.message;
    else if (typeof obj.text === "string") text = obj.text;
    else if (typeof obj.error === "string") text = obj.error;
    else text = String(result);
  } else {
    text = String(result);
  }

  const cleaned = sanitize(text);
  if (cleaned.length > maxLen) {
    return cleaned.slice(0, maxLen) + "…";
  }
  return cleaned;
}

/**
 * Find a tool entry by its toolCallId in an array of entries.
 * Searches from end to front (most recent first).
 * Returns undefined if not found (caller should silently return).
 */
export function findEntryByCallId<T extends { toolCallId: string }>(
  entries: T[],
  callId: string,
): T | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].toolCallId === callId) return entries[i];
  }
  return undefined;
}
