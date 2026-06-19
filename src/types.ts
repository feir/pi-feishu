/**
 * Pi-Feishu 类型定义
 *
 * 使用飞书官方 Bot API（WebSocket 长连接 + REST API）
 */

/** 飞书客户端配置 */
export interface FeishuConfig {
  /** 飞书 App ID */
  appId: string;
  /** 飞书 App Secret */
  appSecret: string;
  /** 域名：feishu（国内）或 lark（海外），默认 feishu */
  domain?: "feishu" | "lark";
  /** 事件加密密钥（可选） */
  encryptKey?: string;
  /** 事件验证令牌（可选） */
  verificationToken?: string;
  /** 允许的发送者 open_id 白名单（空 = 不限制） */
  allowedOpenIds?: string[];
  /** 允许的聊天 chat_id 白名单 */
  allowedChatIds?: string[];
  /** 显式允许任意发送者（默认 false；不建议公网 bot 使用） */
  allowAnySender?: boolean;
  /** Bot open_id，用于校验群聊是否精确 @机器人 */
  botOpenId?: string;
  /** 群聊消息是否要求 @机器人（默认 true；chat 白名单可绕过） */
  requireMentionInGroup?: boolean;
  /** 入站媒体最大字节数（默认 50MB） */
  maxInboundMediaBytes?: number;
}

/** 桥接服务状态 */
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

/** settings.json 中 feishu 配置段 */
export interface FeishuSettingsSection {
  appId?: string;
  appSecret?: string;
  domain?: string;
  encryptKey?: string;
  verificationToken?: string;
  allowedOpenIds?: string[];
  allowedChatIds?: string[];
  allowAnySender?: boolean;
  botOpenId?: string;
  requireMentionInGroup?: boolean;
  maxInboundMediaBytes?: number;
}
