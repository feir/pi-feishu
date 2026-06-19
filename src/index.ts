/**
 * Pi-Feishu 扩展主入口
 *
 * 使用飞书官方 Bot API（WebSocket 长连接）将飞书作为聊天渠道控制 Pi。
 *
 * 功能：
 * 1. 通过飞书官方 Node.js SDK 连接飞书 WebSocket 长连接
 * 2. 接收飞书消息 → 转发为 Pi 用户消息
 * 3. 监听 Pi 响应 → 回传给飞书（回复/新消息/交互卡片）
 * 4. 媒体收发：下载图片/文件 → 上传到 Pi，Pi 生成的图片/文件 → 上传到飞书
 * 5. Reaction 输入指示：处理中显示 Typing，失败显示 CrossMark
 * 6. 工具进度：每个工具调用都实时推送到飞书（可编辑卡片）
 * 7. 中间文本：assistant 思考过程中的文本也推送到飞书
 * 8. 注册 /feishu 命令管理连接状态
 *
 * 消息流程（参考 hermes-agent）：
 *
 *   用户消息 →
 *     [Typing Reaction] →
 *     tool_execution_start → [进度卡片: ⏳ Shell...] →
 *     tool_execution_end   → [进度卡片: ✅ Shell] →
 *     turn_end (text+toolCalls) → [中间文本: "让我查找..."] →
 *     ... 下一轮工具 ... →
 *     turn_end (text only) → [最终回复] →
 *     [移除 Typing Reaction]
 *
 * 配置优先级（从高到低）：
 *   1. CLI 标志: --feishu-app-id, --feishu-app-secret 等
 *   2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET 等
 *   3. Pi settings.json 中的 feishu 字段
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  TurnEndEvent,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, renameSync, realpathSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FeishuClient } from "./feishu-client.js";
import type { InboundResource } from "./feishu-client.js";
import type { FeishuConfig } from "./types.js";
import { summarizeArgs, errorSnippet, findEntryByCallId } from "./tool-summary.js";

// ─── 常量 ─────────────────────────────────────────────

// ponytail: interactive card JSON ≤ 30KB, safeText 上限 20000；chunking 仅用于中间轮工具调用文本
const MAX_TEXT_CHUNK = 20000;

/** 运行时状态目录 */
const STATE_DIR = join(homedir(), ".pi", "agent", "state");
const PROJECTS_MD = join(homedir(), ".pi", "projects.md");
const ACTIVE_PROJECT_FILE = join(STATE_DIR, "active-project");
const RESTART_FLAG = join(STATE_DIR, "restart-flag");
const LOCK_FILE = join(STATE_DIR, "pi-feishu.lock");

/** 工具名到友好名称的映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: "Shell",
  read: "读取文件",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索",
  find: "查找文件",
  ls: "列出目录",
  glob: "匹配文件",
  agent: "子代理",
  send_to_feishu: "发送消息",
  send_image_to_feishu: "发送图片",
  send_file_to_feishu: "发送文件",
};

/** 友好化工具名 */
function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

// ─── workspace-binding 协议 ───────────────────────────

interface ActiveProject {
  id: string;
  root: string;
  boundAt: string;
  source: "id" | "path" | "manual";
}

/** 解析 ~/.pi/projects.md → Map<id, absolutePath> */
function parseProjectsMd(): Map<string, string> {
  const result = new Map<string, string>();
  try {
    if (!existsSync(PROJECTS_MD)) return result;
    const content = readFileSync(PROJECTS_MD, "utf-8");
    const lines = content.split("\n");
    const seen = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^\| *([a-z][a-z0-9-]*) *\| *(\S+) *\|/);
      if (!match) continue;
      const id = match[1];
      if (id === "id") continue; // table header
      let rawPath = match[2];
      if (rawPath === "path") continue; // table header
      if (rawPath.startsWith("~")) {
        rawPath = join(homedir(), rawPath.slice(rawPath[1] === "/" ? 2 : 1));
      }
      if (seen.has(id)) {
        console.warn(`[pi-feishu] projects.md: duplicate id "${id}", using first occurrence`);
        continue;
      }
      seen.add(id);
      result.set(id, rawPath);
    }
  } catch (err) {
    console.warn(`[pi-feishu] failed to parse projects.md: ${err}`);
  }
  return result;
}

/** 读取 ~/.pi/agent/state/active-project */
function readActiveProject(): ActiveProject | null {
  try {
    if (!existsSync(ACTIVE_PROJECT_FILE)) return null;
    const content = readFileSync(ACTIVE_PROJECT_FILE, "utf-8");
    const lines = content.split("\n");
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    if (!fields.id || !fields.root || !fields.source) return null;
    return {
      id: fields.id,
      root: fields.root,
      boundAt: fields.bound_at || "",
      source: fields.source as ActiveProject["source"],
    };
  } catch {
    return null;
  }
}

/** 原子写入 active-project state file (tmpfile + rename) */
function writeActiveProject(id: string, root: string, source: ActiveProject["source"]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const boundAt = new Date().toISOString();
  const content = `id: ${id}\nroot: ${root}\nbound_at: ${boundAt}\nsource: ${source}\n`;
  const tmp = `${ACTIVE_PROJECT_FILE}.${randomUUID()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, ACTIVE_PROJECT_FILE);
}

/** 清除 active-project state file */
function clearActiveProject(): void {
  try { unlinkSync(ACTIVE_PROJECT_FILE); } catch { /* already gone */ }
}

/** touch restart-flag */
function touchRestartFlag(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(RESTART_FLAG, "", "utf-8");
}

// ─── 入口自检 ──────────────────────────────────────

function selfCheck(): void {
  const expectedCwd = join(homedir(), ".pi", "agent");
  const actualCwd = process.cwd();
  const warnings: string[] = [];

  if (actualCwd !== expectedCwd) {
    warnings.push(
      `cwd 异常: 期望 ${expectedCwd}, 实际 ${actualCwd}。` +
      `建议用 ~/.pi/agent/bin/pi-feishu 启动。`,
    );
  }

  try {
    let rawPid: string;
    try {
      rawPid = readFileSync(LOCK_FILE, "utf-8").trim();
    } catch {
      rawPid = readFileSync(join(LOCK_FILE, "pid"), "utf-8").trim();
    }
    const lockPid = parseInt(rawPid, 10);
    if (lockPid !== process.ppid) {
      warnings.push(
        `lock PID ${lockPid} 不是当前父进程 ${process.ppid}。可能不是由启动脚本拉起。`,
      );
    }
  } catch {
    warnings.push(`lock 缺失 ${LOCK_FILE}。建议用启动脚本起。`);
  }

  if (process.env.PI_FEISHU_ACTIVE !== "1") {
    warnings.push(
      `PI_FEISHU_ACTIVE 未设为 1。skill 将不读 active-project state file，` +
      `/cd 切项目不会影响 .specs 路径解析。建议用 ~/.pi/agent/bin/pi-feishu 启动。`,
    );
  }

  for (const w of warnings) {
    console.warn(`[pi-feishu] ${w}`);
  }
}

// ─── 从 Pi settings.json 读取 feishu 配置段 ──────────────

function readFeishuFromSettingsFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    const fs = json?.feishu;
    if (!fs || typeof fs !== "object") return {};
    return {
      appId: fs.appId ?? fs.app_id ?? "",
      appSecret: fs.appSecret ?? fs.app_secret ?? "",
      domain: fs.domain ?? "",
      encryptKey: fs.encryptKey ?? fs.encrypt_key ?? "",
      verificationToken: fs.verificationToken ?? fs.verification_token ?? "",
      allowedOpenIds: fs.allowedOpenIds ?? fs.allowed_open_ids ?? [],
      allowedChatIds: fs.allowedChatIds ?? fs.allowed_chat_ids ?? [],
      allowAnySender: fs.allowAnySender ?? fs.allow_any_sender,
      botOpenId: fs.botOpenId ?? fs.bot_open_id ?? "",
      requireMentionInGroup: fs.requireMentionInGroup ?? fs.require_mention_in_group,
      maxInboundMediaBytes: fs.maxInboundMediaBytes ?? fs.max_inbound_media_bytes,
    };
  } catch {
    return {};
  }
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  }
  return undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function loadConfig(): FeishuConfig {
  const globalSettings = readFeishuFromSettingsFile(
    join(homedir(), ".pi", "agent", "settings.json"),
  );
  const projectSettings = readFeishuFromSettingsFile(
    join(process.cwd(), ".pi", "settings.json"),
  );
  const s: Record<string, unknown> = { ...globalSettings, ...projectSettings };

  const domain = (process.env.FEISHU_DOMAIN || s.domain || "feishu") as "feishu" | "lark";
  const allowAnySender = parseBool(process.env.FEISHU_ALLOW_ANY_SENDER ?? s.allowAnySender);
  const requireMentionInGroup = parseBool(process.env.FEISHU_REQUIRE_MENTION_IN_GROUP ?? s.requireMentionInGroup);

  return {
    appId: String(process.env.FEISHU_APP_ID || s.appId || ""),
    appSecret: String(process.env.FEISHU_APP_SECRET || s.appSecret || ""),
    domain,
    encryptKey: String(process.env.FEISHU_ENCRYPT_KEY || s.encryptKey || "") || undefined,
    verificationToken: String(process.env.FEISHU_VERIFICATION_TOKEN || s.verificationToken || "") || undefined,
    allowedOpenIds: parseList(process.env.FEISHU_ALLOWED_OPEN_IDS ?? s.allowedOpenIds),
    allowedChatIds: parseList(process.env.FEISHU_ALLOWED_CHAT_IDS ?? s.allowedChatIds),
    allowAnySender,
    botOpenId: String(process.env.FEISHU_BOT_OPEN_ID || s.botOpenId || "") || undefined,
    requireMentionInGroup,
    maxInboundMediaBytes: parsePositiveInt(process.env.FEISHU_MAX_INBOUND_MEDIA_BYTES ?? s.maxInboundMediaBytes),
  };
}

// ─── Chat 状态 ──────────────────────────────────────────

interface ChatState {
  chatId: string;
  /** 用户原始消息 ID，用于 reply threading */
  userMsgId: string;

  // ── 工具进度追踪 ──
  /** 进度卡片消息 ID（所有工具共用一个可编辑卡片） */
  progressMsgId: string | null;
  /** 卡片是否正在创建中（防止竞态重复创建） */
  progressCreating: boolean;
  /** 工具执行记录 */
  toolEntries: Array<{
    name: string;
    status: "running" | "done" | "error";
    toolCallId: string;
    argSummary?: string;
    errorSnippet?: string;
    args?: unknown;
    result?: unknown;
  }>;
}

// ─── 扩展入口 ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: FeishuClient | null = null;
  let config: FeishuConfig = loadConfig();
  let ctxRef: ExtensionContext | null = null;

  /** 每个聊天独立的状态 */
  const chatStates: Map<string, ChatState> = new Map();

  // ─── 消息队列 ──────────────────────────────────────────

  interface QueuedMessage {
    msgId: string;
    text: string;
    resources: InboundResource[];
    chatType: "p2p" | "group";
  }

  interface ChatQueue {
    processing: boolean;
    queue: QueuedMessage[];
  }

  /** 每个聊天的消息队列 */
  const chatQueues: Map<string, ChatQueue> = new Map();

  /** 全局状态变更锁（/cd /update），防止并发切项目/更新 */
  let mutationInProgress = false;

  // ─── 安全门 ──────────────────────────────────────────

  /** ctx 可能在 session replacement/reload 后 stale；所有访问都必须防崩。 */
  function ctxIsIdle(): boolean {
    try { return ctxRef?.isIdle() ?? true; } catch { ctxRef = null; return true; }
  }

  function ctxHasPendingMessages(): boolean {
    try { return ctxRef?.hasPendingMessages?.() ?? false; } catch { ctxRef = null; return false; }
  }

  function ctxAbort(): void {
    try { ctxRef?.abort(); } catch { ctxRef = null; }
  }

  function ctxCompact(): boolean {
    try { ctxRef?.compact(); return true; } catch { ctxRef = null; return false; }
  }

  function ctxContextUsage(): ReturnType<ExtensionContext["getContextUsage"]> | undefined {
    try { return ctxRef?.getContextUsage(); } catch { ctxRef = null; return undefined; }
  }

  function ctxShutdown(): void {
    try { ctxRef?.shutdown(); } catch { ctxRef = null; process.exit(0); }
  }

  /** 检查当前是否安全执行全局状态变更（/cd /update） */
  function safeToMutate(): boolean {
    if (mutationInProgress) return false;
    if (!ctxIsIdle()) return false;
    if (ctxHasPendingMessages()) return false;
    for (const q of chatQueues.values()) {
      if (q.processing || q.queue.length > 0) return false;
    }
    return true;
  }

  // ─── 注册 CLI 标志 ────────────────────────────────────

  pi.registerFlag("feishu-app-id", {
    description: "飞书 App ID",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-app-secret", {
    description: "飞书 App Secret",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-domain", {
    description: "飞书域名 (feishu 或 lark)",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-encrypt-key", {
    description: "飞书事件加密密钥（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-verification-token", {
    description: "飞书事件验证令牌（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-allowed-open-ids", {
    description: "允许的发送者 open_id，逗号分隔（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-allowed-chat-ids", {
    description: "允许的 chat_id，逗号分隔（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-allow-any-sender", {
    description: "显式允许任意发送者 (true/false，默认 false)",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-bot-open-id", {
    description: "Bot open_id，用于精确校验群聊 @机器人（可选）",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-require-mention-in-group", {
    description: "群聊是否要求 @机器人 (true/false，默认 true)",
    type: "string",
    default: "",
  });
  pi.registerFlag("feishu-max-inbound-media-bytes", {
    description: "入站媒体最大字节数（默认 50MB）",
    type: "string",
    default: "",
  });

  // ─── 启动飞书客户端 ──────────────────────────────────

  async function startFeishuClient(): Promise<void> {
    if (client) {
      client.disconnect();
      client = null;
    }

    const flagMap: Record<string, string> = {
      appId: "feishu-app-id",
      appSecret: "feishu-app-secret",
      domain: "feishu-domain",
      encryptKey: "feishu-encrypt-key",
      verificationToken: "feishu-verification-token",
    };
    const overrides: Partial<FeishuConfig> = {};
    for (const [key, flag] of Object.entries(flagMap)) {
      const val = pi.getFlag(flag);
      if (val) (overrides as any)[key] = String(val);
    }
    const allowedOpenIdsFlag = pi.getFlag("feishu-allowed-open-ids");
    if (allowedOpenIdsFlag) overrides.allowedOpenIds = parseList(String(allowedOpenIdsFlag));
    const allowedChatIdsFlag = pi.getFlag("feishu-allowed-chat-ids");
    if (allowedChatIdsFlag) overrides.allowedChatIds = parseList(String(allowedChatIdsFlag));
    const allowAnySenderFlag = pi.getFlag("feishu-allow-any-sender");
    if (allowAnySenderFlag) overrides.allowAnySender = parseBool(String(allowAnySenderFlag));
    const botOpenIdFlag = pi.getFlag("feishu-bot-open-id");
    if (botOpenIdFlag) overrides.botOpenId = String(botOpenIdFlag);
    const requireMentionFlag = pi.getFlag("feishu-require-mention-in-group");
    if (requireMentionFlag) overrides.requireMentionInGroup = parseBool(String(requireMentionFlag));
    const maxMediaFlag = pi.getFlag("feishu-max-inbound-media-bytes");
    if (maxMediaFlag) overrides.maxInboundMediaBytes = parsePositiveInt(String(maxMediaFlag));

    config = { ...config, ...overrides };

    if (!config.appId || !config.appSecret) {
      try {
        if (ctxRef?.hasUI) ctxRef.ui.notify("飞书连接失败：缺少 appId/appSecret", "error");
      } catch { ctxRef = null; }
      return;
    }

    client = new FeishuClient(config);

    client.setOnMessage((chatId, msgId, text, chatType, resources) => {
      handleFeishuMessage(chatId, msgId, text, chatType, resources).catch((err) => {
        console.warn("[pi-feishu] handleFeishuMessage failed:", err?.message ?? err);
      });
    });
    client.setOnStatusChange((status) => {
      updateStatus(ctxRef, status);
    });

    try {
      await client.connect();
    } catch (err) {
      try {
        if (ctxRef?.hasUI) ctxRef.ui.notify(`飞书连接错误: ${err}`, "error");
      } catch { ctxRef = null; }
    }
  }

  // ─── 处理飞书入站消息 → 排队或直接处理 ────────────────

  async function handleFeishuMessage(
    chatId: string,
    msgId: string,
    text: string,
    chatType: "p2p" | "group",
    resources: InboundResource[],
  ): Promise<void> {
    const content = text.trim();
    if (!content && resources.length === 0) return;

    // ── 拦截斜杠命令 ──
    if (content.startsWith("/")) {
      await handleSlashCommand(chatId, msgId, content);
      return;
    }

    // ── 入队 ──
    const queue = chatQueues.get(chatId) ?? { processing: false, queue: [] };
    chatQueues.set(chatId, queue);

    queue.queue.push({ msgId, text: content, resources, chatType });

    if (queue.processing) {
      // 当前正在处理 → 通知排队
      const pos = queue.queue.length;
      await client?.sendMessage(
        chatId,
        `已排队 (前面还有 ${pos - 1} 条)`,
        msgId,
      );
      flashStatus(`飞书: 📥 排队中 (${pos})`);
      return;
    }

    // 当前空闲 → 开始处理
    await dequeueAndProcess(chatId);
  }

  /** 从队列取出下一条消息并开始处理 */
  async function dequeueAndProcess(chatId: string): Promise<void> {
    const queue = chatQueues.get(chatId);
    if (!queue || queue.queue.length === 0) {
      // 队列空，标记空闲
      if (queue) queue.processing = false;
      return;
    }

    // Pi 正忙（压缩中/流式中）→ 不出队，保持 processing=false 等空闲时再触发
    if (!ctxIsIdle()) {
      queue.processing = false;
      return;
    }

    // ponytail: client 可能在重连/双实例抢占时短暂为 null，等 flushAllQueues 重试
    const feishu = client;
    if (!feishu) {
      queue.processing = false;
      return;
    }

    queue.processing = true;
    const item = queue.queue.shift()!;

    flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

    // 下载入站媒体
    let resourceDescription = "";
    for (const res of item.resources) {
      const localPath = await feishu.downloadResource(
        item.msgId,
        res.fileKey,
        res.type,
        res.fileName,
      );
      if (localPath) {
        const typeLabel =
          res.type === "image" ? "图片" :
          res.type === "audio" ? "语音" :
          res.type === "video" ? "视频" : "文件";
        resourceDescription += `\n[收到${typeLabel}: ${localPath}]`;
      }
    }

    // 初始化聊天状态
    chatStates.set(chatId, {
      chatId,
      userMsgId: item.msgId,
      progressMsgId: null,
      progressCreating: false,
      toolEntries: [],
    });

    // 添加 Typing Reaction
    await feishu.startTyping(chatId, item.msgId);

    // 发送给 Pi
    const fullContent = item.text + (resourceDescription ? "\n" + resourceDescription : "");
    pi.sendUserMessage(fullContent);
  }

  // ─── 斜杠命令处理 ──────────────────────────────────────

  /**
   * 处理从飞书发来的斜杠命令。
   * 这些命令不会发给 LLM，而是直接在扩展层执行或回复提示。
   */
  async function handleSlashCommand(
    chatId: string,
    msgId: string,
    text: string,
  ): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (cmd) {
      case "/new": {
        // 清空飞书侧状态
        const state = chatStates.get(chatId);
        const queue = chatQueues.get(chatId);

        if (state) {
          client?.stopTyping(chatId, false).catch(() => {});
          chatStates.delete(chatId);
        }
        if (queue) {
          queue.queue = [];
          queue.processing = false;
        }

        // 中断当前处理
        if (!ctxIsIdle()) {
          ctxAbort();
        }

        // 压缩上下文清除历史
        if (ctxCompact()) {
          await client?.sendMessage(chatId, "会话已重置，上下文已清空。", msgId);
        } else {
          await client?.sendMessage(chatId, "无法重置：会话上下文不可用。", msgId);
        }
        break;
      }

      case "/stop": {
        // 中断当前处理 + 清空队列
        const state = chatStates.get(chatId);
        const queue = chatQueues.get(chatId);
        const clearedCount = queue?.queue.length ?? 0;

        if (state) {
          client?.stopTyping(chatId, false).catch(() => {});
          chatStates.delete(chatId);
        }
        if (queue) {
          queue.queue = [];
          queue.processing = false;
        }

        if (!ctxIsIdle()) {
          ctxAbort();
          await client?.sendMessage(chatId, "已中断当前处理，队列已清空。", msgId);
        } else if (clearedCount > 0) {
          await client?.sendMessage(chatId, `已清空 ${clearedCount} 条排队消息。`, msgId);
        } else {
          await client?.sendMessage(chatId, "当前没有正在处理的任务。", msgId);
        }
        break;
      }

      case "/queue": {
        const queue = chatQueues.get(chatId);
        const state = chatStates.get(chatId);
        const count = queue?.queue.length ?? 0;
        const idle = ctxIsIdle();

        if (!state && count === 0) {
          await client?.sendMessage(chatId, "队列为空，当前空闲。", msgId);
        } else {
          let reply = idle ? "状态: 空闲" : "状态: 处理中";
          if (count > 0) {
            reply += `\n排队中: ${count} 条消息`;
          }
          await client?.sendMessage(chatId, reply, msgId);
        }
        break;
      }

      case "/compact": {
        if (ctxCompact()) {
          await client?.sendMessage(chatId, "已触发上下文压缩。", msgId);
        } else {
          await client?.sendMessage(chatId, "无法执行：会话上下文不可用。", msgId);
        }
        break;
      }

      case "/status": {
        const status = client?.getStatus() ?? "未启动";
        const ctxUsage = ctxContextUsage();
        const queue = chatQueues.get(chatId);
        let reply = `Pi 状态:\n- 飞书连接: ${status}\n- App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}`;
        if (ctxUsage && ctxUsage.tokens !== null) {
          reply += `\n- 上下文: ${ctxUsage.tokens}/${ctxUsage.contextWindow} tokens (${ctxUsage.percent ?? "?"}%)`;
        }
        if (queue && queue.queue.length > 0) {
          reply += `\n- 排队: ${queue.queue.length} 条`;
        }
        await client?.sendMessage(chatId, reply, msgId);
        break;
      }

      case "/cd": {
        if (!safeToMutate()) {
          await client?.sendMessage(chatId, "pi 还在处理任务/队列，请稍后再 /cd", msgId);
          break;
        }
        mutationInProgress = true;
        try {
          await handleCdCommand(chatId, msgId, args);
        } finally {
          mutationInProgress = false;
        }
        break;
      }

      case "/update": {
        if (!safeToMutate()) {
          await client?.sendMessage(chatId, "pi 还在处理任务/队列，请稍后再 /update", msgId);
          break;
        }
        mutationInProgress = true;
        let shutdownRequested = false;
        try {
          shutdownRequested = await handleUpdateCommand(chatId, msgId);
        } finally {
          if (!shutdownRequested) mutationInProgress = false;
        }
        break;
      }

      case "/quota": {
        await handleQuotaCommand(chatId, msgId);
        break;
      }

      case "/help": {
        const helpText = [
          "可用命令:",
          "  /new       - 新建会话（重置上下文）",
          "  /stop      - 中断当前处理，清空排队",
          "  /queue     - 查看排队状态",
          "  /compact   - 压缩上下文",
          "  /status    - 查看 Pi 状态",
          "  /quota     - 查看模型配额",
          "  /cd        - 查看/切换活跃项目",
          "  /cd <id>   - 绑定到 projects.md 注册的项目",
          "  /cd --list  - 列出所有注册项目",
          "  /update    - 拉取更新、构建并重启 pi-feishu",
          "  /help      - 显示帮助",
          "",
          "以下命令请在 Pi 终端中执行:",
          "  /model     - 切换模型",
          "  /tools     - 管理工具",
        ].join("\n");
        await client?.sendMessage(chatId, helpText, msgId);
        break;
      }

      default: {
        await client?.sendMessage(
          chatId,
          `命令 ${cmd} 不支持通过飞书执行。请在 Pi 终端中使用。`,
          msgId,
        );
        break;
      }
    }
  }

  // ─── /cd 命令处理 ───────────────────────────────────

  async function handleCdCommand(
    chatId: string,
    msgId: string,
    args: string,
  ): Promise<void> {
    const trimmed = args.trim();

    // /cd (无参) → 查看当前绑定
    if (!trimmed) {
      const current = readActiveProject();
      if (current) {
        await client?.sendMessage(
          chatId,
          `当前绑定: **${current.id}**\n路径: ${current.root}\n绑定时间: ${current.boundAt}`,
          msgId,
        );
      } else {
        await client?.sendMessage(
          chatId,
          `未绑定项目，回退到 pi 启动目录: ${process.cwd()}`,
          msgId,
        );
      }
      return;
    }

    // /cd --list → 列出所有注册项目
    if (trimmed === "--list" || trimmed === "-l") {
      if (!existsSync(PROJECTS_MD)) {
        await client?.sendMessage(chatId, "❌ 找不到 ~/.pi/projects.md", msgId);
        return;
      }
      const projects = parseProjectsMd();
      if (projects.size === 0) {
        await client?.sendMessage(chatId, "projects.md 为空，暂无注册项目。", msgId);
        return;
      }
      const current = readActiveProject();
      const lines = [...projects.entries()].map(([id, path]) => {
        const marker = current?.id === id ? " ★" : "";
        return `- **${id}**${marker}: ${path}`;
      });
      await client?.sendMessage(
        chatId,
        `注册项目 (${projects.size}):\n${lines.join("\n")}`,
        msgId,
      );
      return;
    }

    // /cd clear
    if (trimmed === "clear") {
      clearActiveProject();
      await client?.sendMessage(chatId, "✅ 已清除绑定", msgId);
      return;
    }

    // 判断是 path-like 还是纯 token
    const isPathLike = /[\/~.]/.test(trimmed);

    if (isPathLike) {
      // /cd <path> → 直接 realpath 绑定
      let resolved: string;
      try {
        let expanded = trimmed;
        if (expanded.startsWith("~")) {
          expanded = join(homedir(), expanded.slice(expanded[1] === "/" ? 2 : 1));
        }
        resolved = realpathSync(expanded);
      } catch {
        await client?.sendMessage(chatId, `❌ 路径不存在: ${trimmed}`, msgId);
        return;
      }

      const id = basename(resolved);
      writeActiveProject(id, resolved, "path");
      await client?.sendMessage(
        chatId,
        `✅ 已绑定到 **${id}**: ${resolved}`,
        msgId,
      );
      return;
    }

    // /cd <id> → 查 projects.md
    if (!existsSync(PROJECTS_MD)) {
      await client?.sendMessage(
        chatId,
        "❌ 找不到 ~/.pi/projects.md。用 `/cd <绝对路径>` 直接绑定。",
        msgId,
      );
      return;
    }

    const projects = parseProjectsMd();
    const root = projects.get(trimmed);

    if (!root) {
      const ids = [...projects.keys()].join(", ");
      await client?.sendMessage(
        chatId,
        `❌ projects.md 无 **${trimmed}**。可用 id: ${ids || "(无)"}`,
        msgId,
      );
      return;
    }

    // 校验目录存在，并写入 realpath 后的绝对路径
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(root);
    } catch {
      await client?.sendMessage(
        chatId,
        `❌ projects.md 中 ${trimmed} 指向的路径不存在: ${root}`,
        msgId,
      );
      return;
    }

    writeActiveProject(trimmed, resolvedRoot, "id");
    await client?.sendMessage(
      chatId,
      `✅ 已绑定到 **${trimmed}**: ${resolvedRoot}`,
      msgId,
    );
  }

  // ─── 包根路径推导 ─────────────────────────────────

  /**
   * 从 import.meta.url 向上查找 package.json name=pi-feishu，
   * 避免硬编码路径（如 ~/.pi/agent/git/github.com/feir/pi-feishu）。
   * 回退到 process.cwd()，保持与硬编码路径的行为兼容。
   */
  function resolvePackageRoot(): string {
    try {
      const currentFile = fileURLToPath(import.meta.url);
      let dir = dirname(currentFile);
      const root = "/";
      while (dir !== root) {
        try {
          const pkgPath = join(dir, "package.json");
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (pkg.name === "pi-feishu") return realpathSync(dir);
          }
        } catch { /* try parent */ }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch { /* fall through */ }
    // 回退到当前源码编译运行的 cwd，兼容现有行为
    return realpathSync(process.cwd());
  }

  // ─── /update 命令处理 ────────────────────────────────

  async function handleUpdateCommand(
    chatId: string,
    msgId: string,
  ): Promise<boolean> {
    const PKG_ROOT = resolvePackageRoot();

    await client?.sendMessage(chatId, "🔄 准备更新...", msgId);

    // Step 1: 检查工作区清洁
    const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: PKG_ROOT, timeout: 10000 });
    if (statusResult.code !== 0 || statusResult.stdout.trim() !== "") {
      await client?.sendMessage(
        chatId,
        "❌ 工作区不干净（有未提交的改动）。请先提交或暂存改动后再 /update。",
        msgId,
      );
      return false;
    }

    // Step 2: 记录 BEFORE_SHA
    const beforeResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: PKG_ROOT, timeout: 10000 });
    if (beforeResult.code !== 0) {
      await client?.sendMessage(chatId, `❌ 无法获取当前 HEAD: ${beforeResult.stderr}`, msgId);
      return false;
    }
    const BEFORE_SHA = beforeResult.stdout.trim();

    // Step 3: git pull --ff-only
    const pullResult = await pi.exec("git", ["pull", "--ff-only"], { cwd: PKG_ROOT, timeout: 60000 });
    if (pullResult.code !== 0) {
      await client?.sendMessage(
        chatId,
        `❌ git pull 失败:\n\`\`\`\n${pullResult.stderr.substring(0, 500)}\n\`\`\``,
        msgId,
      );
      return false;
    }

    // Step 4: 检查是否有更新
    const afterResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: PKG_ROOT, timeout: 10000 });
    const AFTER_SHA = afterResult.stdout.trim();
    if (AFTER_SHA === BEFORE_SHA) {
      const short = BEFORE_SHA.substring(0, 7);
      await client?.sendMessage(chatId, `ℹ️ 已是最新 (${short})`, msgId);
      return false;
    }

    // Step 5: npm ci
    const ciResult = await pi.exec("npm", ["ci", "--silent"], { cwd: PKG_ROOT, timeout: 120000 });
    if (ciResult.code !== 0) {
      const rolledBack = await rollbackToBefore(BEFORE_SHA, PKG_ROOT);
      await client?.sendMessage(
        chatId,
        `❌ npm ci 失败，${rolledBack ? "已回滚到更新前" : "回滚失败，请人工检查"}。`,
        msgId,
      );
      return false;
    }

    // Step 6: 强制验证代码：有 build 跑 build，否则跑 typecheck
    const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
    const validation = pkgJson.scripts?.build
      ? { label: "build", args: ["run", "build"] }
      : pkgJson.scripts?.typecheck
        ? { label: "typecheck", args: ["run", "typecheck"] }
        : null;

    if (!validation) {
      const rolledBack = await rollbackToBefore(BEFORE_SHA, PKG_ROOT);
      await client?.sendMessage(
        chatId,
        `❌ package.json 缺少 build/typecheck 脚本，${rolledBack ? "已回滚" : "回滚失败，请人工检查"}。`,
        msgId,
      );
      return false;
    }

    const validationResult = await pi.exec("npm", validation.args, { cwd: PKG_ROOT, timeout: 120000 });
    if (validationResult.code !== 0) {
      const rolledBack = await rollbackToBefore(BEFORE_SHA, PKG_ROOT);
      await client?.sendMessage(
        chatId,
        `❌ ${validation.label} 失败:\n\`\`\`\n${validationResult.stderr.substring(0, 500)}\n\`\`\`\n${rolledBack ? "已回滚到更新前。" : "回滚失败，请人工检查。"}`,
        msgId,
      );
      return false;
    }

    // Step 7: 先回复成功，再 touch restart-flag + shutdown，避免发送失败留下 stale flag
    const short = AFTER_SHA.substring(0, 7);
    await client?.sendMessage(
      chatId,
      `✅ 已更新到 ${short}，重启中...`,
      msgId,
    );
    touchRestartFlag();
    ctxShutdown();
    return true;
  }

  /** 回滚到 BEFORE_SHA：git reset + best-effort npm ci && build/typecheck */
  async function rollbackToBefore(beforeSha: string, pkgRoot: string): Promise<boolean> {
    const resetResult = await pi.exec("git", ["reset", "--hard", beforeSha], { cwd: pkgRoot, timeout: 30000 });
    const resetOk = resetResult.code === 0;
    try {
      await pi.exec("npm", ["ci", "--silent"], { cwd: pkgRoot, timeout: 120000 });
    } catch { /* best-effort */ }
    try {
      const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
      if (pkgJson.scripts?.build) {
        await pi.exec("npm", ["run", "build"], { cwd: pkgRoot, timeout: 120000 });
      } else if (pkgJson.scripts?.typecheck) {
        await pi.exec("npm", ["run", "typecheck"], { cwd: pkgRoot, timeout: 120000 });
      }
    } catch { /* best-effort */ }
    return resetOk;
  }

  // ─── /quota 命令处理 ─────────────────────────────────

  async function handleQuotaCommand(chatId: string, msgId: string): Promise<void> {
    const healthPath = join(STATE_DIR, "health-cache.json");
    let healthData: Record<string, unknown> | null = null;

    // Try reading health cache file
    if (existsSync(healthPath)) {
      try {
        healthData = JSON.parse(readFileSync(healthPath, "utf-8"));
      } catch {
        // stale/corrupt, ignore
      }
    }

    if (!healthData || !healthData.models) {
      await client?.sendMessage(chatId, "暂无配额数据。pi-main-fallback 扩展可能未加载，或尚未完成首次健康检查。", msgId);
      return;
    }

    const models = healthData.models as Record<string, Record<string, unknown>>;
    const ts = healthData.ts as number;
    const age = ts ? Math.floor((Date.now() - ts) / 1000) : -1;

    const statusEmoji: Record<string, string> = {
      healthy: "🟢",
      unavailable: "🔴",
      exhausted: "⛔",
      unknown: "❓",
    };

    const providerNames: Record<string, string> = {
      "anthropic/claude-opus-4-7": "Anthropic (Claude Opus 4)",
      "openai-codex/gpt-5.5": "Codex (GPT-5.5)",
      "deepseek/deepseek-v4-pro": "DeepSeek (V4 Pro)",
    };

    const lines: string[] = ["📊 **模型配额**"];

    for (const [key, info] of Object.entries(models)) {
      const name = providerNames[key] ?? key;
      const status = (info.status as string) ?? "unknown";
      const emoji = statusEmoji[status] ?? "❓";

      lines.push("");
      lines.push(`${emoji} **${name}**: ${status}`);

      if (info.error) {
        lines.push(`   ↳ 错误: ${info.error}`);
      }

      const util = info.utilization as Record<string, number> | undefined;
      if (util) {
        const utilParts: string[] = [];
        for (const [w, v] of Object.entries(util)) {
          utilParts.push(`${w}: ${v.toFixed(1)}%`);
        }
        if (utilParts.length > 0) {
          lines.push(`   ↳ 使用率: ${utilParts.join(", ")}`);
        }
      }

      if (info.balance) {
        lines.push(`   ↳ 余额: ${info.balance} ${info.currency ?? "CNY"}`);
      }

      if (info.resetAt && typeof info.resetAt === "number" && info.resetAt > Date.now()) {
        const resetDate = new Date(info.resetAt);
        const remaining = Math.floor((info.resetAt - Date.now()) / 1000);
        const hr = Math.floor(remaining / 3600);
        const min = Math.floor((remaining % 3600) / 60);
        lines.push(`   ↳ 重置: ${resetDate.toLocaleString("zh-CN")} (${hr}h${min}m 后)`);
      }
    }

    // ─── Cooldowns (round 2 fix: HIGH-5) ──────────────
    const cooldowns = healthData.cooldowns as Array<{ model: string; until: number; reason: string }> | undefined;
    if (cooldowns && cooldowns.length > 0) {
      lines.push("");
      lines.push("⏳ **冷却中**");
      for (const cd of cooldowns) {
        if (cd.until <= Date.now()) continue;
        const remaining = Math.floor((cd.until - Date.now()) / 1000);
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        lines.push(`   ${providerNames[cd.model] ?? cd.model}: ${min}m${sec}s (${cd.reason})`);
      }
    }

    // ─── Exhaustion (round 2 fix: HIGH-5) ─────────────
    const exhaustion = healthData.exhaustion as { suspended: boolean; suspendUntil: number; consecutive: number } | undefined;
    if (exhaustion?.suspended && exhaustion.suspendUntil > Date.now()) {
      const wait = Math.floor((exhaustion.suspendUntil - Date.now()) / 1000);
      const min = Math.floor(wait / 60);
      const sec = wait % 60;
      lines.push("");
      lines.push(`⛔ **链尾退避** (第 ${exhaustion.consecutive} 次): ${min}m${sec}s 后重试`);
    }

    // ─── Recent fallback events + counters (round 2 fix: HIGH-5) ──
    const counters = healthData.counters as Record<string, number> | undefined;
    if (counters && Object.keys(counters).length > 0) {
      lines.push("");
      lines.push("📈 **累计 fallback (按原因)**");
      for (const [reason, count] of Object.entries(counters).sort((a, b) => b[1] - a[1])) {
        lines.push(`   ${reason}: ${count}`);
      }
    }
    const recentEvents = healthData.recentEvents as Array<{ ts: number; reason: string; from: string; to: string }> | undefined;
    if (recentEvents && recentEvents.length > 0) {
      lines.push("");
      lines.push(`🕒 **最近 ${Math.min(recentEvents.length, 5)} 次切换**`);
      for (const ev of recentEvents.slice(-5).reverse()) {
        const evAge = Math.floor((Date.now() - ev.ts) / 1000);
        lines.push(`   ${evAge}s 前: ${ev.from} → ${ev.to} (${ev.reason})`);
      }
    }

    if (age >= 0) {
      lines.push("");
      lines.push(`_数据 ${age}s 前更新_`);
    }

    await client?.sendMessage(chatId, lines.join("\n"), msgId);
  }

  // ═══════════════════════════════════════════════════════
  //  Pi 事件处理 — 工具进度 + 文本回复
  // ═══════════════════════════════════════════════════════

  // ─── tool_execution_start → 更新进度卡片 ──────────────

  pi.on("tool_execution_start", (event: any) => {
    if (!client || client.getStatus() !== "connected") return;
    const state = findActiveState();
    if (!state) return;

    const toolName = event.toolName as string;
    const toolCallId = event.toolCallId as string;
    const argSummary = summarizeArgs(toolName, event.args);
    state.toolEntries.push({
      name: toolName,
      status: "running",
      toolCallId,
      argSummary,
      args: event.args,
    });

    updateProgressCard(state);
    flashStatus(`飞书: 🔧 ${toolDisplayName(toolName)}...`);
  });

  // ─── tool_execution_end → 更新进度卡片 ────────────────

  pi.on("tool_execution_end", (event: any) => {
    if (!client || client.getStatus() !== "connected") return;
    const state = findActiveState();
    if (!state) return;

    const toolCallId = event.toolCallId as string;
    const isError = event.isError as boolean;

    const entry = findEntryByCallId(state.toolEntries, toolCallId);
    if (!entry) return;

    entry.status = isError ? "error" : "done";
    entry.result = event.result;
    if (isError) {
      entry.errorSnippet = errorSnippet(event.result);
    }

    updateProgressCard(state);
  });

  // ─── turn_end → 发送中间/最终文本 ─────────────────────

  pi.on("turn_end", (event: TurnEndEvent) => {
    if (!client || client.getStatus() !== "connected") return;
    const state = findActiveState();
    if (!state) return;

    const message = event.message;
    if (!message || message.role !== "assistant") return;

    // ── 检测 LLM 错误 ──
    if (message.stopReason === "error") {
      const errMsg = message.errorMessage ?? "LLM 返回了未知错误";
      client.sendMessage(state.chatId, `LLM 错误: ${errMsg}`, state.userMsgId).catch(() => {});
      client.stopTyping(state.chatId, false).catch(() => {});
      flashStatus("飞书: ⚠️ LLM 错误");
      return;
    }

    const textContent = extractTextFromMessage(message);
    if (!textContent) return;

    // 标题降级
    const processed = downgradeHeadings(textContent);

    // 检查这一轮是否包含工具调用
    const hasToolCalls = message.content?.some((block: any) => block.type === "toolCall");

    if (hasToolCalls) {
      // 中间轮：assistant 有文本 + 工具调用 → 发送中间文本（回复到用户消息）
      const chunks = chunkText(processed, MAX_TEXT_CHUNK);
      for (const chunk of chunks) {
        client.sendMessage(state.chatId, chunk, state.userMsgId).catch(() => {});
      }
    } else {
      // 最终轮（或无工具调用的单轮）
      if (state.progressMsgId) {
        // 有进度卡 → patch 卡片合并最终回复
        const panels = buildEntryPanels(state.toolEntries);
        const card = FeishuClient.buildCompletedCard(panels, processed, "完成");
        client.updateCard(state.progressMsgId, card).catch(() => {});
      } else {
        // 无进度卡 → 发送文本（单卡片，safeText 处理超长截断）
        client.sendMessage(state.chatId, processed).catch(() => {});
      }
    }

    flashStatus(`飞书: 📤 推送中 (${textContent.length}字)`);
  });

  // ─── agent_end → 清理 + 处理下一条排队消息 ──────────

  pi.on("agent_end", (_event: AgentEndEvent) => {
    // 本地状态清理不依赖 Feishu 连接状态
    const state = findActiveState();
    if (!state) return;

    const chatId = state.chatId;

    chatStates.delete(chatId);

    // 网络操作 best-effort
    client?.stopTyping(chatId, true).catch(() => {});

    // 刷新所有队列（包括当前聊天）
    const queue = chatQueues.get(chatId);
    if (queue) queue.processing = false;
    flushAllQueues();
    flashStatus("飞书: ✅ 完成");
  });

  // ─── Pi 空闲时刷新所有队列 ─────────────────────────────

  /**
   * 检查所有聊天的队列，Pi 空闲时尝试处理下一条。
   * 在 agent_end、session_compact、session_start 后调用。
   */
  function flushAllQueues(): void {
    if (!client || client.getStatus() !== "connected") return;
    if (!ctxIsIdle()) return;

    for (const [chatId, queue] of chatQueues) {
      if (!queue.processing && queue.queue.length > 0) {
        dequeueAndProcess(chatId).catch(() => {
          queue.processing = false;
        });
      }
    }
  }

  // 压缩完成后，刷新队列（可能有积压消息）
  pi.on("session_compact", async () => {
    // 延迟一小段，等 Pi 完全恢复空闲
    setTimeout(() => flushAllQueues(), 500);
  });

  // ═══════════════════════════════════════════════════════
  //  进度卡片
  // ═══════════════════════════════════════════════════════

  /** 格式化值用于卡片 code block 显示（保留换行，截断过大的内容） */
  function formatForCodeBlock(value: unknown, maxLen = 3000): string {
    if (value === undefined || value === null) return "";
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else {
      try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
    }
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + "\n... (截断)";
    }
    return text.replace(/```/g, "\\`\\`\\`");
  }

  /** 构建单个工具的 collapsible_panel 元素 */
  function buildEntryPanel(
    entry: ChatState["toolEntries"][number],
  ): Record<string, unknown> {
    const displayName = toolDisplayName(entry.name);
    const detail = entry.argSummary ? ` · ${entry.argSummary}` : "";

    let titleContent: string;
    switch (entry.status) {
      case "running":
        titleContent = `⏳ **${displayName}**${detail}`;
        break;
      case "done":
        titleContent = `✅ ~~${displayName}~~${detail}`;
        break;
      case "error":
        titleContent = `❌ **${displayName}**${detail}`;
        if (entry.errorSnippet) {
          titleContent += `\n   ↳ ${entry.errorSnippet}`;
        }
        break;
    }

    const bodyElements: Record<string, unknown>[] = [];

    // 完整参数
    if (entry.args !== undefined) {
      const argsText = formatForCodeBlock(entry.args);
      bodyElements.push({
        tag: "markdown",
        content: `**输入参数**\n\`\`\`json\n${argsText}\n\`\`\``,
      });
    }

    // 完整结果 / 运行中占位
    if (entry.status === "running") {
      bodyElements.push({ tag: "markdown", content: "⏳ 执行中..." });
    } else if (entry.result !== undefined) {
      const resultText = formatForCodeBlock(entry.result);
      bodyElements.push({
        tag: "markdown",
        content: `**输出结果**\n\`\`\`\n${resultText}\n\`\`\``,
      });
    }

    return {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: titleContent },
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: bodyElements,
    };
  }

  /**
   * 构建工具进度卡片元素数组。
   * 每个工具调用一个 collapsible_panel，标题保留当前摘要，展开区显示完整 args/result。
   * 只保留最近 10 次操作。
   */
  function buildEntryPanels(
    entries: ChatState["toolEntries"],
  ): Record<string, unknown>[] {
    const MAX_DISPLAY = 10;
    const total = entries.length;
    const display = total > MAX_DISPLAY ? entries.slice(-MAX_DISPLAY) : entries;

    const panels: Record<string, unknown>[] = [];

    if (total > MAX_DISPLAY) {
      panels.push({
        tag: "markdown",
        content: `... 前 ${total - MAX_DISPLAY} 次操作已折叠`,
      });
    }

    for (const entry of display) {
      panels.push(buildEntryPanel(entry));
    }
    return panels;
  }

  /** 创建或更新进度卡片（防竞态：全生命周期只创建一条消息） */
  function updateProgressCard(state: ChatState): void {
    if (!client) return;

    const panels = buildEntryPanels(state.toolEntries);
    const runningCount = state.toolEntries.filter((e) => e.status === "running").length;
    const status = runningCount > 0 ? `执行中 (${runningCount})` : "工具调用";

    const card = FeishuClient.buildProgressCard(panels, status);

    // 情况 1: 卡片已创建 → 直接更新
    if (state.progressMsgId) {
      client.updateCard(state.progressMsgId, card).catch(() => {
        state.progressMsgId = null;
        state.progressCreating = false;
      });
      return;
    }

    // 情况 2: 卡片正在创建中 → 跳过，等创建完成后会自动刷新
    if (state.progressCreating) {
      return;
    }

    // 情况 3: 首次创建
    state.progressCreating = true;
    client.sendCard(state.chatId, card, state.userMsgId).then((cardMsgId) => {
      state.progressCreating = false;
      if (cardMsgId) {
        state.progressMsgId = cardMsgId;
        // 创建后立即用最新状态刷新（可能有新事件在创建期间发生）
        const latestPanels = buildEntryPanels(state.toolEntries);
        const latestRunning = state.toolEntries.filter((e) => e.status === "running").length;
        const latestStatus = latestRunning > 0 ? `执行中 (${latestRunning})` : "工具调用";
        const latestCard = FeishuClient.buildProgressCard(latestPanels, latestStatus);
        client?.updateCard(cardMsgId, latestCard).catch(() => {});
      }
    }).catch(() => {
      state.progressCreating = false;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  辅助
  // ═══════════════════════════════════════════════════════

  function findActiveState(): ChatState | null {
    let lastKey: string | null = null;
    for (const key of chatStates.keys()) {
      lastKey = key;
    }
    if (!lastKey) return null;
    return chatStates.get(lastKey) ?? null;
  }

  // ─── 注册 /feishu 命令 ────────────────────────────────

  pi.registerCommand("feishu", {
    description: "管理飞书 Bot 连接 (start/stop/status/config/help)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase() || "status";

      switch (action) {
        case "start":
          await startFeishuClient();
          ctx.ui.notify("飞书客户端已启动", "info");
          break;

        case "stop":
          if (client) {
            client.disconnect();
            client = null;
          }
          ctx.ui.notify("飞书客户端已停止", "info");
          break;

        case "status": {
          const status = client?.getStatus() ?? "未启动";
          ctx.ui.notify(
            `飞书 Bot 状态: ${status}\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}`,
            "info",
          );
          break;
        }

        case "config":
          ctx.ui.notify(
            `当前配置:\n` +
              `App ID: ${config.appId ? "****" + config.appId.slice(-4) : "未设置"}\n` +
              `App Secret: ${config.appSecret ? "****" : "未设置"}\n` +
              `Domain: ${config.domain || "feishu"}\n` +
              `Encrypt Key: ${config.encryptKey ? "已设置" : "未设置"}\n` +
              `Verification Token: ${config.verificationToken ? "已设置" : "未设置"}`,
            "info",
          );
          break;

        case "help":
          ctx.ui.notify(
            `/feishu 命令用法:\n` +
              `  /feishu start   - 启动飞书 Bot 连接\n` +
              `  /feishu stop    - 断开飞书 Bot 连接\n` +
              `  /feishu status  - 查看连接状态\n` +
              `  /feishu config  - 查看当前配置\n` +
              `  /feishu help    - 显示帮助\n\n` +
              `配置优先级（从高到低）:\n` +
              `  1. CLI 标志: --feishu-app-id, --feishu-app-secret\n` +
              `  2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET\n` +
              `  3. settings.json 中的 feishu 字段`,
            "info",
          );
          break;

        default:
          ctx.ui.notify(`未知命令: ${action}，使用 /feishu help 查看帮助`, "warning");
      }
    },
  });

  // ─── 注册自定义工具 ──────────────────────────────────

  // 发送文本消息
  const SendToFeishuParams = {
    type: "object" as const,
    properties: {
      message: { type: "string" as const, description: "要发送的消息内容" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID（飞书 chat_id），留空则发送到最近活跃的聊天",
      },
    },
    required: ["message"],
  };

  pi.registerTool({
    name: "send_to_feishu",
    label: "发送到飞书",
    description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
    parameters: SendToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const message = params.message as string;
      const chatId = (params.chat_id as string) || findActiveState()?.chatId;

      if (!client || client.getStatus() !== "connected") {
        return {
          content: [
            { type: "text" as const, text: "错误: 飞书 Bot 未连接。请先运行 /feishu start 启动连接。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [
            { type: "text" as const, text: "错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。" },
          ],
          details: {} as Record<string, unknown>,
        };
      }

      await client.sendMessage(chatId, downgradeHeadings(message));
      return {
        content: [{ type: "text" as const, text: `已发送到飞书 [${chatId}]: ${message}` }],
        details: { sent: true, chatId, message } as Record<string, unknown>,
      };
    },
  });

  // 发送图片
  const SendImageToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地图片文件路径" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path"],
  };

  pi.registerTool({
    name: "send_image_to_feishu",
    label: "发送图片到飞书",
    description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
    parameters: SendImageToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendImageToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const chatId = (params.chat_id as string) || findActiveState()?.chatId;

      const feishuImg = client;
      if (!feishuImg || feishuImg.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const imageKey = await feishuImg.uploadImage(filePath);
      if (!imageKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 图片上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await feishuImg.sendImage(chatId, imageKey);
      return {
        content: [{ type: "text" as const, text: `图片已发送到飞书 [${chatId}]: ${filePath}` }],
        details: { sent: true, chatId, filePath, imageKey } as Record<string, unknown>,
      };
    },
  });

  // 发送文件
  const SendFileToFeishuParams = {
    type: "object" as const,
    properties: {
      file_path: { type: "string" as const, description: "本地文件路径" },
      file_name: { type: "string" as const, description: "文件名" },
      chat_id: {
        type: "string" as const,
        description: "目标聊天 ID，留空则发送到最近活跃的聊天",
      },
    },
    required: ["file_path", "file_name"],
  };

  pi.registerTool({
    name: "send_file_to_feishu",
    label: "发送文件到飞书",
    description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
    parameters: SendFileToFeishuParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SendFileToFeishuParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const filePath = params.file_path as string;
      const fileName = params.file_name as string;
      const chatId = (params.chat_id as string) || findActiveState()?.chatId;

      const feishuFile = client;
      if (!feishuFile || feishuFile.getStatus() !== "connected") {
        return {
          content: [{ type: "text" as const, text: "错误: 飞书 Bot 未连接。" }],
          details: {} as Record<string, unknown>,
        };
      }

      if (!chatId) {
        return {
          content: [{ type: "text" as const, text: "错误: 没有活跃的飞书聊天。" }],
          details: {} as Record<string, unknown>,
        };
      }

      const fileKey = await feishuFile.uploadFile(filePath, fileName);
      if (!fileKey) {
        return {
          content: [{ type: "text" as const, text: "错误: 文件上传失败。" }],
          details: {} as Record<string, unknown>,
        };
      }

      await feishuFile.sendFile(chatId, fileKey);
      return {
        content: [{ type: "text" as const, text: `文件已发送到飞书 [${chatId}]: ${fileName}` }],
        details: { sent: true, chatId, filePath, fileName, fileKey } as Record<string, unknown>,
      };
    },
  });

  // ─── 会话生命周期 ─────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    selfCheck();
    updateStatus(ctx, "disconnected");

    try {
      await startFeishuClient();
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.notify(`飞书连接失败: ${err}`, "error");
      }
    }

    // 启动后刷新积压的队列
    flushAllQueues();
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      client.disconnect();
      client = null;
    }
    chatStates.clear();
  });

  // ─── 工具函数 ────────────────────────────────────────

  /**
   * Markdown 标题降级：所有出站文本的标题层级 +2，最小 H6。
   * 规则：只处理行首 # 开头、不在代码块内的标题行。
   *   H1 → H3, H2 → H4, H3 → H5, H4 → H6, H5/H6 → H6
   */
  function downgradeHeadings(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      // 追踪代码块状态
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        result.push(line);
        continue;
      }

      if (inCodeBlock) {
        result.push(line);
        continue;
      }

      // 匹配行首标题：1-6 个 # 后跟空格或行尾
      const match = line.match(/^(#{1,6})\s/);
      if (match) {
        const level = match[1].length;
        const newLevel = Math.min(level + 2, 6);
        result.push("#".repeat(newLevel) + line.slice(level));
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /** 从 Pi 消息中提取文本内容 */
  function extractTextFromMessage(message: any): string | null {
    if (!message?.content) return null;
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }

  /** 状态栏瞬态消息定时器 */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStatusText: string = "";

  function updateStatus(ctx: ExtensionContext | null, status: string): void {
    try {
      if (!ctx?.hasUI) return;

      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }

      const statusMap: Record<string, string> = {
        connecting: "飞书: 连接中",
        connected: "飞书: 已连接",
        disconnected: "飞书: 未连接",
        error: "飞书: 错误",
      };

      const text = statusMap[status] ?? `飞书: ${status}`;
      if (currentStatusText === text) return;
      currentStatusText = text;
      ctx.ui.setStatus("feishu", text);
    } catch {
      if (ctx === ctxRef) ctxRef = null;
    }
  }

  function flashStatus(message: string): void {
    try {
      if (!ctxRef?.hasUI) return;
      if (statusTimer) clearTimeout(statusTimer);

      if (currentStatusText === message) return;
      currentStatusText = message;
      ctxRef.ui.setStatus("feishu", message);

      statusTimer = setTimeout(() => {
        statusTimer = null;
        try {
          if (client && client.getStatus() === "connected") {
            const text = "飞书: 已连接";
            if (currentStatusText !== text) {
              currentStatusText = text;
              ctxRef?.ui.setStatus("feishu", text);
            }
          }
        } catch { ctxRef = null; }
      }, 3000);
    } catch { ctxRef = null; }
  }

  function chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitPos = remaining.lastIndexOf("\n", maxLen);
      if (splitPos <= 0) {
        splitPos = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitPos <= 0) {
        chunks.push(remaining.substring(0, maxLen));
        remaining = remaining.substring(maxLen);
      } else {
        chunks.push(remaining.substring(0, splitPos + 1));
        remaining = remaining.substring(splitPos + 1);
      }
    }

    return chunks;
  }
}
