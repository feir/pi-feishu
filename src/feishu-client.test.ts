/**
 * feishu-client.test.ts — 最小测试：消息过期、授权过滤、媒体大小 helper
 *
 * 使用 Node.js 内置 assert 模块；npm test 会先用现有 TypeScript 编译到 /tmp 再运行。
 */

import assert from "node:assert";
import { FeishuClient } from "./feishu-client.js";
import type { FeishuConfig } from "./types.js";

// ─── 测试助手 ──────────────────────────────────────────

function makeConfig(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: "test-app-id",
    appSecret: "test-secret",
    ...overrides,
  };
}

/** 创建一个触发"快速失败"的发送器：构造消息事件并调用内部处理路径 */
async function triggerAuthCheck(
  client: FeishuClient,
  overrides: {
    senderOpenId?: string;
    chatId?: string;
    chatType?: "p2p" | "group";
    mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    createTime?: string;
  },
): Promise<{ accepted: boolean }> {
  const data: any = {
    sender: {
      sender_id: { open_id: overrides.senderOpenId ?? "ou_test_user" },
      sender_type: "user",
    },
    message: {
      message_id: `msg_${Math.random().toString(36).slice(2)}`,
      chat_id: overrides.chatId ?? "oc_test_chat",
      chat_type: overrides.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions: overrides.mentions ?? [],
      create_time: overrides.createTime,
    },
  };

  // 注入测试标志：用反射监听 onMessageCallback 是否被调用
  let accepted = false;
  const origCb = (client as any).onMessageCallback;
  (client as any).onMessageCallback = (...args: unknown[]) => {
    accepted = true;
    if (origCb) origCb(...args);
  };

  // 调用私有 handleInboundMessage（通过反射）
  try {
    await (client as any).handleInboundMessage(data);
  } catch {
    // ignore
  }

  // 恢复
  (client as any).onMessageCallback = origCb;

  return { accepted };
}

// ─── 1. 消息过期（30 分钟） ──────────────────────────

{
  const client = new FeishuClient(makeConfig());

  // 30 分钟前的消息应被视为过期
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000 - 1000; // 比 30 分钟多 1 秒
  assert.strictEqual(
    client.isMessageExpired(String(thirtyMinAgo)),
    true,
    "超过 30 分钟的消息应该过期",
  );

  // 29 分钟前的消息不应过期
  const twentyNineMinAgo = Date.now() - 29 * 60 * 1000;
  assert.strictEqual(
    client.isMessageExpired(String(twentyNineMinAgo)),
    false,
    "不足 30 分钟的消息不应过期",
  );

  // 1 秒前的消息不应过期
  const oneSecAgo = Date.now() - 1000;
  assert.strictEqual(
    client.isMessageExpired(String(oneSecAgo)),
    false,
    "最近消息不应过期",
  );

  // 无效 create_time 不视为过期
  assert.strictEqual(
    client.isMessageExpired("invalid"),
    false,
    "无效时间不视为过期",
  );

  console.log("✅ 消息过期测试通过 (30分钟)");
}

// ─── 2. 授权过滤：allowedOpenIds ──────────────────────

{
  const client = new FeishuClient(
    makeConfig({ allowedOpenIds: ["ou_whitelisted", "ou_admin"] }),
  );

  // 白名单用户通过
  const r1 = await triggerAuthCheck(client, { senderOpenId: "ou_whitelisted" });
  assert.strictEqual(r1.accepted, true, "白名单用户应通过");

  // 非白名单用户被拒绝
  const r2 = await triggerAuthCheck(client, { senderOpenId: "ou_stranger" });
  assert.strictEqual(r2.accepted, false, "非白名单用户应被拒绝");

  // 空 open_id 被拒绝
  const r3 = await triggerAuthCheck(client, { senderOpenId: "" });
  assert.strictEqual(r3.accepted, false, "空 open_id 应被拒绝");

  console.log("✅ allowedOpenIds 过滤测试通过");
}

// ─── 3. 授权过滤：allowedChatIds ──────────────────────

{
  const client = new FeishuClient(
    makeConfig({ allowedChatIds: ["oc_room_a", "oc_room_b"] }),
  );

  const r1 = await triggerAuthCheck(client, { chatId: "oc_room_a" });
  assert.strictEqual(r1.accepted, true, "白名单聊天应通过");

  const r2 = await triggerAuthCheck(client, { chatId: "oc_unknown" });
  assert.strictEqual(r2.accepted, false, "非白名单聊天应被拒绝");

  const r3 = await triggerAuthCheck(client, {
    chatId: "oc_room_a",
    chatType: "group",
    mentions: [],
  });
  assert.strictEqual(r3.accepted, true, "白名单群聊无需 mention 也应通过");

  console.log("✅ allowedChatIds 过滤测试通过");
}

// ─── 4. 群聊 mention 检查 ─────────────────────────────

{
  // 默认 requireMentionInGroup=true；allowAnySender=true 时允许宽松 mention fallback
  const client = new FeishuClient(makeConfig({ allowAnySender: true }));

  // 群聊无 mention → 拒绝
  const r1 = await triggerAuthCheck(client, {
    chatType: "group",
    mentions: [],
  });
  assert.strictEqual(r1.accepted, false, "群聊无 mention 应拒绝");

  // 群聊有 mention → 通过（显式 allowAnySender 的宽松 fallback）
  const r2 = await triggerAuthCheck(client, {
    chatType: "group",
    mentions: [{ key: "@_user_1", id: { open_id: "ou_123" }, name: "张三" }],
  });
  assert.strictEqual(r2.accepted, true, "allowAnySender 下群聊有 mention 应通过");

  // p2p 不受 mention 限制，但仍需要 allowAnySender 或白名单
  const r3 = await triggerAuthCheck(client, {
    chatType: "p2p",
    mentions: [],
  });
  assert.strictEqual(r3.accepted, true, "allowAnySender 下 p2p 应通过");

  console.log("✅ 群聊 mention 检查测试通过");
}

// ─── 5. requireMentionInGroup=false 绕过 ──────────────

{
  const client = new FeishuClient(
    makeConfig({ allowedOpenIds: ["ou_test_user"], requireMentionInGroup: false }),
  );

  const r1 = await triggerAuthCheck(client, {
    chatType: "group",
    mentions: [],
  });
  assert.strictEqual(r1.accepted, true, "requireMentionInGroup=false 时群聊无 mention 仍通过");

  console.log("✅ requireMentionInGroup=false 测试通过");
}

// ─── 6. extractContentLength helper ───────────────────

{
  const client = new FeishuClient(makeConfig());
  const extract = (client as any).extractContentLength.bind(client);

  // Map 形式
  const m = new Map([["content-length", "12345"]]);
  assert.strictEqual(extract({ headers: m }), 12345, "应解析 Map 中的 content-length");

  // 普通对象
  assert.strictEqual(
    extract({ headers: { "Content-Length": "9999" } }),
    9999,
    "应解析对象中的 content-length（大小写不敏感）",
  );

  // 数组形式
  assert.strictEqual(
    extract({ headers: [["Content-Length", "42"]] }),
    42,
    "应解析数组中的 content-length（大小写不敏感）",
  );

  // 无 headers
  assert.strictEqual(extract({}), null, "无 headers 时返回 null");

  // 无 content-length 头
  assert.strictEqual(
    extract({ headers: { "content-type": "image/png" } }),
    null,
    "无 content-length 时返回 null",
  );

  console.log("✅ extractContentLength 测试通过");
}

// ─── 7. 默认 fail-closed，allowAnySender 显式放开 ────

{
  const closed = new FeishuClient(makeConfig());
  const r1 = await triggerAuthCheck(closed, { senderOpenId: "anyone" });
  assert.strictEqual(r1.accepted, false, "默认无白名单应拒绝任意发送者");

  const open = new FeishuClient(makeConfig({ allowAnySender: true }));
  const r2 = await triggerAuthCheck(open, { senderOpenId: "anyone" });
  assert.strictEqual(r2.accepted, true, "allowAnySender=true 时允许任意发送者");

  console.log("✅ 默认 fail-closed / allowAnySender 测试通过");
}

// ─── 8. 群聊精确 @bot ─────────────────────────────────

{
  const client = new FeishuClient(
    makeConfig({ allowedOpenIds: ["ou_test_user"], botOpenId: "ou_bot" }),
  );

  const wrongMention = await triggerAuthCheck(client, {
    chatType: "group",
    mentions: [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "张三" }],
  });
  assert.strictEqual(wrongMention.accepted, false, "群聊未精确 @bot 应拒绝");

  const botMention = await triggerAuthCheck(client, {
    chatType: "group",
    mentions: [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "bot" }],
  });
  assert.strictEqual(botMention.accepted, true, "群聊精确 @bot 应通过");

  console.log("✅ 群聊精确 @bot 测试通过");
}

console.log("\n🎉 所有测试通过！");
