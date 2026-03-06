# Claude Auth API Reference

供其他语言实现参考的认证与调用规范。

---

## 1. Token 类型与识别

| 类型 | 前缀 | 最小长度 | 来源 |
|------|------|---------|------|
| Setup Token (OAuth) | `sk-ant-oat01-` | 80 字符 | `claude setup-token` |
| API Key | `sk-ant-api03-` | - | console.anthropic.com |

**判断方式：** 字符串包含 `sk-ant-oat` 即为 OAuth token，否则视为 API Key。

---

## 2. 认证 Header 构造

### 2.1 OAuth Token (setup-token)

```
Authorization: Bearer <token>
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14
content-type: application/json
```

> `oauth-2025-04-20` 是必须的，缺少会返回 401。

### 2.2 API Key

```
x-api-key: <key>
anthropic-version: 2023-06-01
anthropic-beta: fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14
content-type: application/json
```

### 2.3 伪代码

```
function build_headers(token):
    headers = {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    if "sk-ant-oat" in token:
        headers["authorization"] = "Bearer " + token
        headers["anthropic-beta"] = join(",", [
            "claude-code-20250219",
            "oauth-2025-04-20",
            "fine-grained-tool-streaming-2025-05-14",
            "interleaved-thinking-2025-05-14"
        ])
    else:
        headers["x-api-key"] = token
        headers["anthropic-beta"] = join(",", [
            "fine-grained-tool-streaming-2025-05-14",
            "interleaved-thinking-2025-05-14"
        ])
    return headers
```

---

## 3. Messages API

### 3.1 Endpoint

```
POST https://api.anthropic.com/v1/messages
```

### 3.2 Request Body (非流式)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

### 3.3 Request Body (流式)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "stream": true,
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

### 3.4 Model 别名表

| 别名 | 实际模型 ID |
|------|------------|
| `opus` | `claude-opus-4-6` |
| `opus-4.6` | `claude-opus-4-6` |
| `opus-4.5` | `claude-opus-4-5` |
| `sonnet` | `claude-sonnet-4-6` |
| `sonnet-4.6` | `claude-sonnet-4-6` |
| `sonnet-4.5` | `claude-sonnet-4-5` |
| `haiku` | `claude-haiku-4-5-20251001` |

### 3.5 非流式 Response

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"}
  ],
  "model": "claude-sonnet-4-6",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 15
  }
}
```

提取文本: `response.content[0].text`

### 3.6 流式 Response (SSE)

响应为 `text/event-stream`，每行格式：

```
event: <event_type>
data: <json>
```

关键事件类型：

| 事件 | 用途 | data 结构 |
|------|------|----------|
| `message_start` | 消息开始 | `{"type":"message_start","message":{...}}` |
| `content_block_start` | 内容块开始 | `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` |
| `content_block_delta` | 文本增量 | `{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}` |
| `content_block_stop` | 内容块结束 | `{"type":"content_block_stop","index":0}` |
| `message_delta` | 消息结束信息 | `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}` |
| `message_stop` | 消息完成 | `{"type":"message_stop"}` |

**流式解析伪代码：**

```
for line in sse_lines:
    if not line.startswith("data: "):
        continue
    json_str = line[6:]
    event = parse_json(json_str)

    if event.type == "content_block_delta":
        if event.delta.type == "text_delta":
            print(event.delta.text)  // 追加输出

    if event.type == "message_delta":
        // event.usage 包含最终 token 用量
```

---

## 4. Usage 查询 API

### 4.1 OAuth Usage API

```
GET https://api.anthropic.com/api/oauth/usage

Headers:
  Authorization: Bearer <oauth_token>
  anthropic-version: 2023-06-01
  anthropic-beta: oauth-2025-04-20
  Accept: application/json
```

**Response 结构：**

```json
{
  "five_hour": {
    "utilization": 12.5,
    "resets_at": "2026-03-06T18:00:00Z"
  },
  "seven_day": {
    "utilization": 45.2,
    "resets_at": "2026-03-10T00:00:00Z"
  },
  "seven_day_sonnet": {
    "utilization": 30.0
  }
}
```

`utilization` 为 0-100 的百分比。

> 注意：如果 token 缺少 `user:profile` scope，会返回 403。

### 4.2 Claude.ai Web Session 备用方案

适用于有 claude.ai 浏览器 session key 的场景。

**Step 1 - 获取组织 ID：**

```
GET https://claude.ai/api/organizations

Headers:
  Cookie: sessionKey=<session_key>
  Accept: application/json
```

返回数组，取 `[0].uuid` 作为 `org_id`。

**Step 2 - 获取用量：**

```
GET https://claude.ai/api/organizations/<org_id>/usage

Headers:
  Cookie: sessionKey=<session_key>
  Accept: application/json
```

Response 结构同 4.1。

### 4.3 Session Key 来源

按优先级查找：

1. 环境变量 `CLAUDE_AI_SESSION_KEY` 或 `CLAUDE_WEB_SESSION_KEY`（以 `sk-ant-` 开头）
2. 环境变量 `CLAUDE_WEB_COOKIE`（从 cookie 字符串中提取 `sessionKey=...`）

**Cookie 解析伪代码：**

```
cookie = strip_prefix("cookie: ", raw_cookie)
match = regex("(?:^|;\s*)sessionKey=([^;\s]+)", cookie)
session_key = match.group(1)  // 必须以 "sk-ant-" 开头才有效
```

---

## 5. 错误处理

| HTTP 状态码 | 含义 | 处理建议 |
|-------------|------|---------|
| 401 | 认证失败 | 检查 token 前缀和 header（OAuth 是否带了 `oauth-2025-04-20` beta） |
| 403 | 权限不足 | scope 不够或 token 过期 |
| 429 | 限流 | 读取 `Retry-After` header，等待后重试 |
| 500/529 | 服务端错误 | 指数退避重试（2s, 4s, 8s, 16s），最多 4 次 |

错误响应统一格式：

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "invalid x-api-key"
  }
}
```

---

## 6. 各语言实现 Checklist

- [ ] Token 类型识别（`sk-ant-oat` 判断）
- [ ] 两套 header 构造（OAuth Bearer vs x-api-key）
- [ ] 非流式 Messages 调用 + 响应解析
- [ ] 流式 SSE 解析（逐行读取 `data:` 前缀行）
- [ ] Model 别名解析
- [ ] Usage 查询（OAuth API 优先，Web session 备选）
- [ ] 错误处理与重试
- [ ] 环境变量读取（`ANTHROPIC_TOKEN` / `ANTHROPIC_API_KEY`）
