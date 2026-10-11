---
title: Token 消耗台账 · 论坛同步接口与接入交接
type: reference
status: active
date: 2026-10-11
tags: [token-ledger, forum, sync, api, integration]
---

# Token 消耗台账 · 论坛同步接口与接入交接

> 面向论坛侧接入方的完整交接文档：契约、字段、幂等语义、论坛端实现建议、调试方法。
> CLI 侧实现：`src/token-ledger/`（store / forum-sync / service）+ `src/server/token-ledger-routes.ts`。

## 1. 这是什么

天枢 CLI 把用户本机的 token 消耗汇总成**累计快照**，推送到论坛端点，论坛按设备展示消耗榜单/个人页。

数据流：

```
各会话 cache-log.jsonl（计费行，唯一事实源）
        │  字节游标增量消费（append-only，不重扫）
        ▼
~/.rivet/token-ledger.json（本地台账：day×model 累计 + 游标 + 推送回执）
        │  digest 判重，有变更才推
        ▼
POST {forum.endpoint}（累计快照，幂等 upsert）
```

两条关键性质，论坛端可以依赖：

- **累计语义**：每次推送的都是"截至目前的全量累计"，不是增量。丢包、重推、乱序、间隔多久推一次，都不会导致重复计数——论坛端只做 upsert（按 `deviceId` 覆盖最新快照）。
- **本地是权威**：推送失败不影响本地台账增长；端点恢复后下一趟推送自动补齐全部历史。论坛端不需要处理"补洞"。

## 2. 用户侧配置（如何开启同步）

`~/.rivet/config.json`：

```json
{
  "tokenLedger": {
    "deviceName": "小明的 MacBook",
    "forum": {
      "endpoint": "https://forum.example.com/api/token-usage",
      "apiKey": "论坛签发的 Bearer token",
      "autoSync": true,
      "intervalMinutes": 30
    }
  }
}
```

| 字段 | 缺省行为 |
|------|---------|
| `enabled` | 默认 `true`（本地台账始终累计；这只是本地记录，不上传） |
| `deviceName` | 缺省 `os.hostname()`；论坛展示用 |
| `forum.endpoint` | **缺省 = 不上传**。完整 POST URL，客户端不拼路径 |
| `forum.apiKey` | 配置了才带 `Authorization: Bearer` 头 |
| `forum.autoSync` | 默认 `false`；`true` 且 endpoint 已配时，会话内每 `intervalMinutes`（默认 30）推一趟，退出时冲刷最后一趟（3s 有界） |

环境变量覆盖（联调/多环境）：`RIVET_FORUM_API` 覆盖 endpoint，`RIVET_FORUM_TOKEN` 覆盖 apiKey。

## 3. HTTP 契约（论坛端要实现的部分）

```
POST {用户配置的 endpoint}
Content-Type: application/json
Authorization: Bearer <apiKey>        # 用户配置了就带
```

### 3.1 请求体 `TokenUsageSnapshot`

```json
{
  "version": 1,
  "deviceId": "3f6b2a1c-9e2d-4f7b-b8a1-0c5d6e7f8a9b",
  "deviceName": "小明的 MacBook",
  "sentAt": "2026-10-11T08:30:00.000Z",
  "totals": {
    "requests": 128,
    "input": 3456789,
    "output": 234567,
    "cacheRead": 2900000,
    "cacheCreate": 300000,
    "cost": 5.1234
  },
  "days": [
    {
      "date": "2026-10-10",
      "model": "deepseek-flash",
      "provider": "deepseek",
      "requests": 100,
      "input": 3000000,
      "output": 200000,
      "cacheRead": 2500000,
      "cacheCreate": 300000,
      "cost": 4.5
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `1` | 载荷版本；未来变更会递增，论坛端应拒绝/告警未知版本 |
| `deviceId` | uuid | 安装级匿名 id（首次生成后持久化）。**upsert 主键**。不含任何用户身份信息 |
| `deviceName` | string | 展示名，用户可改 |
| `sentAt` | ISO 8601 | 本次推送时间（客户端时钟） |
| `totals` | object | 全量累计，等于 `days` 的求和（客户端保证一致，论坛端可直接信 totals） |
| `days[]` | array | 逐日 × 模型明细，`date` 升序；同一 (date, model, provider) 只出现一次 |
| `requests` | int | 计费请求数（主请求 + side_path + 中断重试行） |
| `input` | int | cache-**inclusive** 输入 tokens（= uncached + cacheRead + cacheCreate） |
| `output` | int | 输出 tokens |
| `cacheRead` / `cacheCreate` | int | 前缀缓存命中 / 创建 tokens |
| `cost` | number | 按用户本地定价配置估算（DeepSeek 官方含峰谷）。**缺定价的模型计 0**——它是估算下限，不是账单 |
| `provider` | string? | 老数据行可能缺省；缺省时论坛端按空串处理 |

### 3.2 响应约定与客户端行为

| 论坛响应 | 客户端行为 |
|---------|-----------|
| 2xx | 确认：钉住已确认摘要，台账无新变化时不再推 |
| 4xx（除 429） | 视为载荷/鉴权问题，**不重试**，回执记 `http_4xx`；修复后用户手动 `/sync` 或等下趟 |
| 429 / 5xx / 网络 / 超时(10s) | 瞬态：当场重试一次（1s 退避），仍失败记回执，等下一趟定时推送 |

论坛端返回体内容客户端不解析，任意 JSON/空皆可；建议返回 `{ "ok": true }` 或错误细节方便排查。

## 4. 论坛端实现建议

### 4.1 存储

一张设备快照表即可起步：

```sql
CREATE TABLE token_usage_snapshots (
  device_id      TEXT PRIMARY KEY,        -- = 载荷 deviceId
  api_key_id     TEXT NOT NULL,           -- 鉴权时解析出的论坛用户/key id
  device_name    TEXT NOT NULL,
  version        INT  NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL,
  totals         JSONB NOT NULL,          -- {requests,input,output,cacheRead,cacheCreate,cost}
  days           JSONB NOT NULL,          -- day×model 明细数组
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

 upsert：`INSERT ... ON CONFLICT (device_id) DO UPDATE SET ...`。**不需要去重表**——累计快照天然幂等，重复投递收敛到同一状态。

要防乱序覆盖（旧快照晚到）可加一行守卫：`WHERE excluded.sent_at > token_usage_snapshots.sent_at`。

### 4.2 鉴权

- 论坛给用户签发 token（个人设置页生成，可吊销）；用户填进 CLI 配置。
- 端点校验 `Authorization: Bearer`，把 `deviceId` 绑定到该 token 对应的账号；**同账号多设备** = 多条 `deviceId` 记录，个人页按账号聚合。

### 4.3 展示聚合

- 今日/本周：`days` 里按 `date` 过滤求和（date 是客户端本地时区的 `YYYY-MM-DD`）。
- 榜单：按 `totals.input + totals.output` 或 `totals.cost` 排序（注意 cost 是估算下限）。
- 缓存率：`cacheRead / input`（分母为 cache-inclusive 口径）。

## 5. 本地调试（论坛联调时用）

桌面 sidecar 暴露三条路由（`Authorization: Bearer <sidecar token>`），也可用于自检：

```bash
# 本地台账视图（窗口聚合 + 全量累计）
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/summary?days=30"

# 同步状态：deviceId / 是否有未确认变更(pending) / 上次推送回执
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/status"

# 立即同步一次（联调主力；未配置 endpoint 返回 400 + 配置提示）
curl -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/token-ledger/sync"
```

联调技巧：`RIVET_FORUM_API=http://localhost:4000/hook rivet` 起个本地接收端即可看到真实载荷，不需要先配 config。

## 6. 边界与 FAQ

- **payload 里没有会话内容**：只有 token 计数与模型名，不含代码、prompt、文件路径。
- **deviceId 重置**：删 `~/.rivet/token-ledger.json` 会生成新 deviceId 并从 cache-log 全量重建台账——论坛端会看到一个"新设备"，旧记录需管理员合并（或保留，按账号聚合则自动正确）。
- **用户中途换 endpoint**：累计语义保证新端点第一趟就拿到完整历史。
- **cost 口径**：按客户端配置的定价估算（官方 DeepSeek 走峰谷价），未定价模型计 0；账单以平台为准，论坛展示建议标注"估算"。
- **version 演进**：新增字段只向后兼容地加；破坏性变更递增 `version`，论坛端对未知版本返回 4xx 即可让客户端停推并留回执。
