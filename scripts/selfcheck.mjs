// selfcheck.mjs — verify tool-summary logic with node:assert
// keep in sync with src/tool-summary.ts
// Run: node scripts/selfcheck.mjs
import assert from "node:assert/strict";

// ─── Duplicated from src/tool-summary.ts (pure functions, keep in sync) ───

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const WHITESPACE_RE = /\s+/g;

function sanitize(s) {
  return s
    .replace(CONTROL_RE, "")
    .replace(WHITESPACE_RE, " ")
    .replace(/`/g, "\\`")
    .trim();
}

function summarizeArgs(toolName, args) {
  if (!args || typeof args !== "object") return "";

  let raw = "";

  switch (toolName) {
    case "bash":
      raw = typeof args.command === "string" ? args.command : "";
      break;
    case "read":
    case "edit":
    case "write":
    case "find":
    case "ls":
      raw =
        typeof args.path === "string"
          ? args.path
          : typeof args.pattern === "string"
            ? args.pattern
            : "";
      break;
    case "grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      const glob = typeof args.glob === "string" ? ` (${args.glob})` : "";
      raw = pattern ? pattern + glob : "";
      break;
    }
    case "subagent":
    case "agent":
      raw =
        typeof args.agent === "string"
          ? args.agent
          : args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0
            ? "(parallel)"
            : "";
      break;
    default: {
      const firstString = Object.values(args).find((v) => typeof v === "string");
      raw = firstString ?? "";
      break;
    }
  }

  if (!raw) return "";
  const cleaned = sanitize(raw);
  return cleaned.length > 80 ? cleaned.slice(0, 80) + "\u2026" : cleaned;
}

function extractContentText(obj) {
  const content = obj.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ");
}

function errorSnippet(result, maxLen = 200) {
  if (!result) return "";
  let text;
  if (typeof result === "string") text = result;
  else if (result instanceof Error) text = result.message;
  else if (typeof result === "object") {
    const fromContent = extractContentText(result);
    if (fromContent) text = fromContent;
    else if (typeof result.message === "string") text = result.message;
    else if (typeof result.text === "string") text = result.text;
    else if (typeof result.error === "string") text = result.error;
    else text = String(result);
  } else text = String(result);
  const cleaned = sanitize(text);
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}

function findEntryByCallId(entries, callId) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].toolCallId === callId) return entries[i];
  }
  return undefined;
}

// ─── Test suite ──────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${desc}`);
    console.error(`  ${e.message}`);
    process.exitCode = 1;
  }
}

// ── summarizeArgs ──

test("Bash → args.command", () => {
  assert.strictEqual(summarizeArgs("bash", { command: "ls -la" }), "ls -la");
});

test("Read → args.path", () => {
  assert.strictEqual(summarizeArgs("read", { path: "/a/b/c" }), "/a/b/c");
});

test("Edit → args.path", () => {
  assert.strictEqual(
    summarizeArgs("edit", { path: "/x/y/z.ts", oldText: "..." }),
    "/x/y/z.ts",
  );
});

test("Write → args.path", () => {
  assert.strictEqual(
    summarizeArgs("write", { path: "/out.txt", content: "hello" }),
    "/out.txt",
  );
});

test("find → args.pattern", () => {
  assert.strictEqual(summarizeArgs("find", { pattern: "*.ts" }), "*.ts");
});

test("ls → args.path", () => {
  assert.strictEqual(summarizeArgs("ls", { path: "/tmp" }), "/tmp");
});

test("Grep → pattern + glob", () => {
  assert.strictEqual(
    summarizeArgs("grep", { pattern: "TODO", glob: "*.ts" }),
    "TODO (*.ts)",
  );
});

test("Grep → pattern only (no glob)", () => {
  assert.strictEqual(summarizeArgs("grep", { pattern: "FIXME" }), "FIXME");
});

test("subagent → agent name", () => {
  assert.strictEqual(
    summarizeArgs("subagent", { agent: "scout", task: "find things" }),
    "scout",
  );
});

test("subagent → parallel (tasks array)", () => {
  assert.strictEqual(
    summarizeArgs("subagent", { tasks: [{ agent: "scout" }, { agent: "scout" }] }),
    "(parallel)",
  );
});

test("agent key → agent name", () => {
  assert.strictEqual(
    summarizeArgs("agent", { agent: "developer" }),
    "developer",
  );
});

test("null args → ''", () => {
  assert.strictEqual(summarizeArgs("bash", null), "");
});

test("undefined args → ''", () => {
  assert.strictEqual(summarizeArgs("bash", undefined), "");
});

test("empty object args → ''", () => {
  assert.strictEqual(summarizeArgs("bash", {}), "");
});

test("unknown tool → first string field", () => {
  assert.strictEqual(
    summarizeArgs("unknown_tool", { x: 1, y: "hello world" }),
    "hello world",
  );
});

test("unknown tool → no string field → ''", () => {
  assert.strictEqual(summarizeArgs("unknown_tool", { x: 1, y: 2 }), "");
});

// ── sanitize ──

test("sanitize: newline + backtick + null → safe", () => {
  // \n (0x0a) falls in CONTROL_RE range, stripped before whitespace collapse
  assert.strictEqual(sanitize("a\nb`c\x00d"), "ab\\`cd");
});

test("sanitize: collapse whitespace", () => {
  assert.strictEqual(sanitize("hello  \t world"), "hello world");
});

test("sanitize: escape backticks", () => {
  assert.strictEqual(sanitize("`code`"), "\\`code\\`");
});

test("sanitize: strip control chars (DEL)", () => {
  assert.strictEqual(sanitize("ok\x7fbye"), "okbye");
});

// ── truncation ──

test("summarizeArgs: 100-char command → truncated to 80 + …", () => {
  const long = "x".repeat(100);
  assert.strictEqual(summarizeArgs("bash", { command: long }), "x".repeat(80) + "\u2026");
});

test("summarizeArgs: exactly 80 chars → no truncation", () => {
  const exact80 = "y".repeat(80);
  assert.strictEqual(summarizeArgs("bash", { command: exact80 }), exact80);
});

// ── errorSnippet (Pi tool result shapes) ──

test("errorSnippet: Pi AgentToolResult shape → extracts content[].text", () => {
  const result = {
    content: [{ type: "text", text: "ls: /nonexistent-xyz: No such file or directory" }],
    details: {},
  };
  assert.strictEqual(
    errorSnippet(result),
    "ls: /nonexistent-xyz: No such file or directory",
  );
});

test("errorSnippet: Pi shape with multiple text blocks → joined", () => {
  const result = {
    content: [
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ],
  };
  // sanitize collapses \n to space
  assert.strictEqual(errorSnippet(result), "line1 line2");
});

test("errorSnippet: Pi shape with non-text block → skipped", () => {
  const result = {
    content: [
      { type: "image", data: "..." },
      { type: "text", text: "actual error" },
    ],
  };
  assert.strictEqual(errorSnippet(result), "actual error");
});

test("errorSnippet: string → passthrough sanitized", () => {
  assert.strictEqual(errorSnippet("simple error"), "simple error");
});

test("errorSnippet: Error instance → message", () => {
  assert.strictEqual(errorSnippet(new Error("boom")), "boom");
});

test("errorSnippet: { message } fallback", () => {
  assert.strictEqual(errorSnippet({ message: "fallback msg" }), "fallback msg");
});

test("errorSnippet: 300-char content text → truncated to 200 + …", () => {
  const longText = "x".repeat(300);
  const result = { content: [{ type: "text", text: longText }] };
  assert.strictEqual(errorSnippet(result), "x".repeat(200) + "\u2026");
});

test("errorSnippet: null/undefined → ''", () => {
  assert.strictEqual(errorSnippet(null), "");
  assert.strictEqual(errorSnippet(undefined), "");
});

test("errorSnippet: opaque object → String() fallback (no crash)", () => {
  assert.strictEqual(errorSnippet({ weird: 1 }), "[object Object]");
});

// ── findEntryByCallId ──

test("findEntryByCallId: matches correct entry among same-name entries", () => {
  const entries = [
    { toolCallId: "call-1", name: "bash", status: "running", data: 1 },
    { toolCallId: "call-2", name: "bash", status: "running", data: 2 },
  ];
  assert.strictEqual(findEntryByCallId(entries, "call-1").data, 1);
  assert.strictEqual(findEntryByCallId(entries, "call-2").data, 2);
});

test("findEntryByCallId: returns undefined for unknown callId", () => {
  const entries = [
    { toolCallId: "call-1", name: "bash", status: "running" },
  ];
  assert.strictEqual(findEntryByCallId(entries, "call-3"), undefined);
});

test("findEntryByCallId: empty array → undefined", () => {
  assert.strictEqual(findEntryByCallId([], "call-1"), undefined);
});

// ── Result ──

if (failed > 0) {
  console.error(`\n❌ ${failed} failed, ${passed} passed`);
} else {
  console.log(`\n✅ all ${passed} self-checks passed`);
}
