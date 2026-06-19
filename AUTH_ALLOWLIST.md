# pi-feishu 授权白名单配置指南

本文说明如何获取并配置 pi-feishu 的 **open_id** 与 **chat_id** 白名单，
使只有受信的用户和聊天可以向 Bot 发送消息。

## 前置知识：open_id 是 App 维度的

飞书的 `open_id` **不是用户全局标识**——同一个用户在不同 App 中的 `open_id` 不同。
因此**不能直接复用** `lark CLI` 所用的 App 的 `open_id` 到 pi-feishu 的 App。

- 如果你的 pi-feishu 使用了独立的飞书应用（对接到 pi-feishu Bot），
  则白名单中的 `open_id` 必须是**这个 pi-feishu App 维度**的 `open_id`。
- 如果你的 lark CLI 使用的是另一个飞书应用（如个人助手），
  则通过 lark CLI 查到的 `open_id` **无法直接用于 pi-feishu 的白名单**。

**结论**：白名单 `open_id` 必须来自 pi-feishu 本身所用 App 的上下文。

---

## 1. 获取 chat_id（推荐优先配置）

使用 `lark`/`lark-cli` 查询最近聊天，从中定位你的 pi-feishu Bot 对应的单聊 `chat_id`：

```bash
# 本机命令名通常是 lark；如果你的环境是 lark-cli，替换命令名前缀即可。
lark im +chat-list \
  --as user \
  --types=p2p,group \
  --sort-type ByActiveTimeDesc \
  --page-size 20 \
  --jq '.data.chats[] | {chat_id,name,chat_mode,description}'
```

在输出中找到 pi-feishu Bot 对应的单聊（`chat_mode=p2p`），
记录其 `chat_id`（通常格式如 `oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）。

### 本机示例

> ⚠️ 以下 `chat_id` 仅为本机测试示例，你的环境不同。

```
chat_id: oc_fe1f3cb2d5b6a7c8d9e0f1a2b3c4d5e
chat_type: p2p
```

将 `chat_id` 加入 `allowedChatIds` 白名单，即可放行来自该对话的所有消息。

### 群聊同理

若需要放行某个群聊，同样通过上述命令定位目标群聊的 `chat_id`，加入白名单。
群聊白名单可绕过 `requireMentionInGroup`（无需 @机器人 即可触发）。

---

## 2. 获取 sender open_id（排障限定）

当仅配置 `chat_id` 不够（比如需要在群聊中区分具体用户），
可以用**授权拒绝日志**获取 `senderOpenId`。

### 2.1 通过拒绝日志获取（不需切换配置）

默认 fail-closed 模式下，未白名单用户发消息会被拒绝，启动日志中会打印：

```
Auth denied: sender=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, chat=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx not allowlisted
```

群聊未 @机器人 时：

```
Auth denied: sender=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, chat=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx did not mention bot
```

**操作步骤**：

1. 保持 `allowAnySender: false`（默认）。
2. 让目标用户向 pi-feishu Bot **发送一条消息**。
3. 查看 pi-feishu 启动日志，找到 `Auth denied` 行。
4. 复制其中的 `sender=ou_xxx` 和 `chat=oc_xxx`，写入白名单。

### 2.2 临时放行（仅调试用）

如果只是要确认“事件链路是否正常”，可临时放行：

```bash
# 方式一：环境变量
export FEISHU_ALLOW_ANY_SENDER=true

# 方式二：settings.json
# "allowAnySender": true
```

重启 pi-feishu 后，消息应能正常投递。确认链路后，应关闭 `allowAnySender`，
再通过 2.1 的拒绝日志或 1 中的 `chat_id` 白名单完成正式配置。

> ⚠️ **`allowAnySender=true` 放行所有发送者，仅限排障期间临时使用，事后必须关闭。**

---

## 3. settings.json 配置示例

在项目根目录的 `.pi/settings.json` 或全局 `~/.pi/agent/settings.json` 中配置：

```json
{
  "feishu": {
    "appId": "你的飞书 App ID",
    "appSecret": "你的飞书 App Secret",

    "allowedOpenIds": [
      "ou_your_personal_open_id"
    ],
    "allowedChatIds": [
      "oc_your_p2p_chat_id",
      "oc_your_group_chat_id"
    ],
    "botOpenId": "ou_your_bot_open_id",

    "allowAnySender": false,
    "requireMentionInGroup": true
  }
}
```

### 本机完整示例

> ⚠️ `open_id`/`chat_id` 仅为本机测试数据，你的值不同。
> `appId`/`appSecret` 为占位符，请替换为自己的凭证。

```json
{
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "your_app_secret_here",

    "allowedOpenIds": [
      "ou_1a2b3c4d5e6f7g8h9i0j"
    ],
    "allowedChatIds": [
      "oc_fe1f3cb2d5b6a7c8d9e0f1a2b3c4d5e"
    ],
    "botOpenId": "ou_bot_xxxxxxxxxxxxxxxxxxxxxxxx",
    "requireMentionInGroup": true
  }
}
```

> **注意**：不要将真实 `appSecret` 提交到版本控制。推荐通过环境变量注入：
> ```bash
> export FEISHU_APP_ID="cli_xxx"
> export FEISHU_APP_SECRET="xxx"
> ```

---

## 4. 配置项速查

| 字段 | 说明 | 默认 |
|------|------|------|
| `allowedOpenIds` | 允许的发送者 open_id 白名单（空 = 不按人限制） | `[]` |
| `allowedChatIds` | 允许的聊天 chat_id 白名单（群聊白名单可绕过 @机器人 检查） | `[]` |
| `botOpenId` | Bot 自身的 open_id，用于精确校验群聊 @bot | 无 |
| `allowAnySender` | 放行任意发送者（**仅临时排障，事后必须关闭**） | `false` |
| `requireMentionInGroup` | 群聊消息是否要求 @机器人 | `true` |

> 字段名同时支持 camelCase（如 `allowedOpenIds`）和 snake_case（如 `allowed_open_ids`）。

### 鉴权逻辑

1. **默认 fail-closed**：无白名单配置且 `allowAnySender=false` 时，**拒绝所有入站消息**。
2. **sender 或 chat 任一命中白名单**即可通过。
3. **群聊额外检查**：`requireMentionInGroup=true` 时，群聊消息必须 @机器人，
   除非该群聊已在 `allowedChatIds` 白名单内（白名单群聊可跳过 @检查）。
4. 不会校验自己的消息（Bot 发送的消息自动忽略），且忽略 `sender_type` 为 `bot` 或 `app` 的消息。

### 也可以使用环境变量

| 环境变量 | 对应字段 |
|----------|----------|
| `FEISHU_ALLOWED_OPEN_IDS` | `allowedOpenIds`（逗号分隔） |
| `FEISHU_ALLOWED_CHAT_IDS` | `allowedChatIds`（逗号分隔） |
| `FEISHU_ALLOW_ANY_SENDER` | `allowAnySender`（`true`/`false`） |
| `FEISHU_BOT_OPEN_ID` | `botOpenId` |

---

## 5. 安全提醒

- **`allowAnySender: true` 是排障模式，不是生产配置**。公网 Bot 若开启，
  任何知道 Bot 的用户均可发送消息触发 Agent 执行，存在严重安全风险。
  拿到白名单数据后立即关闭。
- 始终配置至少一个 `allowedChatIds`（推荐从单聊开始），
  逐步扩展信任范围。
- 不要将 `appSecret` 写入提交到仓库的 `settings.json`；
  使用环境变量 `FEISHU_APP_SECRET` 或 Git-ignored 的本地配置文件。
