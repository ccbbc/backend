# 漂流瓶后端 API 说明文档

## 基础
- 基地址：`http://<host>:<port>`，默认 `host=0.0.0.0`、`port=3000`（server.js:433-438）
- 内容类型：`Content-Type: application/json`
- 客户端 IP：优先从请求头 `x-forwarded-for` 解析，否则使用 `req.ip`（server.js:195-197）
- 健康检查：`GET /` 返回 `{"status":"ok"}`（server.js:58-60）

## 数据与规则
- 区域：`main` 主区域、`temp` 临时区域、`memorial` 纪念区（server.js:221、264、292）
- 当天窗口：按 UTC+8 计算 0 点到 24 点（server.js:71-76）
- 回复上限：每个漂流瓶最多 5 次回复（server.js:279-281）
- 主区时效：7 天；
  - 未回复到期删除（server.js:417）
  - 有回复但未满 5 次到期转纪念区（server.js:419-423）
- 临时区时效：1 小时未处理则回主区（server.js:425-429）
- 善恶值：范围 -50~50；善意瓶 `+1`、恶意瓶 `-5`（server.js:216-219）
- 祝福/诅咒判定：按善恶值分段加权（server.js:92-104）

## 错误码约定（HTTP + 业务）
- `429` + `{ error_code: 201 }`：作者当日已达 5 次（server.js:204-206）
- `429` + `{ error_code: 202 }`：同 IP 当日已达 10 次（server.js:206-208）
- `429` + `{ error_code: 301, retry_after }`：命中 2 分钟冷却（server.js:202-203）
- `403` + `{ error_code: 302, until }`：封禁中（server.js:199-200）
- `429` + `{ error_code: 601, message }`：玩家已有临时持有，不能钓取（server.js:275）
- 其他：`400 invalid_payload|invalid_id`、`404 not_found|no_bottle`、`503 not_ready`

## 模型字段（核心）
- `bottles`：`id, item_id, author, content, timestamp, kind(good|bad|normal), reply_count, ip, area, expires_at, type, bless_curse(bless|curse|none), name_send, name_recv, last_holder`
- `replies`：`id, bottle_id, user, content`
- `players`：`id, morality`
- `holds`：`id, bottle_id, holder, held_at, expires_at`
- `memorials`：`id, bottle_id, participants(JSON), created_at`

---

## 健康检查
- `GET /`
- 响应：`200 OK` → `{ "status": "ok" }`

示例（curl）
```
curl http://localhost:3000/
```

示例（PowerShell）
```
Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/'
```

 

## 列表查询
- `GET /bottles`
- Query：
  - `limit`：1..500，默认 `50`
  - `offset`：默认 `0`
  - `area`：`main|temp|memorial`
  - `type`：自定义类型字符串（如 `message`）
  - `sender`：作者（玩家名）
- 响应：`200 OK` → 数组，每项包含：`id, item_id, author, content, timestamp, kind, reply_count, area, type, bless_curse, name_send, name_recv`

示例
```
curl 'http://localhost:3000/bottles?limit=50&area=main&sender=%E7%8E%A9%E5%AE%B6A'
```

## 详情查询
- `GET /bottles/:id`
- 响应：`200 OK` → `{ id, item_id, author, content, timestamp, kind, reply_count, replies: [{ id, user, content }] }`
- 错误：`400 invalid_id`、`404 not_found`

示例
```
curl 'http://localhost:3000/bottles/1'
```

## 投递漂流瓶
- `POST /` 或 `POST /bottles`
- Headers：`Content-Type: application/json`；可选 `x-forwarded-for`
- Body：
  - `item_id`：string（发布新瓶时必填；使用 `reply_to` 时可省略）
  - `author`：string（必填，玩家名）
  - `content`：string（必填）
  - `kind`：`good|bad|normal`（默认 `normal`）
  - `type`：string（默认 `message`）
  - `replies`：array（可选）`[{ user, content }]`
  - `reply_to`：number（可选）当提供此字段时视为“投递回复的别人瓶子”，对指定瓶 `id` 追加回复
- 行为：
  - 若提供 `reply_to`：不占用当天作者次数与 IP 次数，不受 2 分钟冷却影响；追加回复并在满 5 次时转纪念区；成功：`200 OK` → `{ ok: true, id, reply_count }`；上限：`429 { error_code: 501 }`
  - 要求：必须持有该瓶（临时持有未过期）且不是作者本人
  - 错误：`400 { error_code: 701 }`（回复内容为空）、`400 { error_code: 702 }`（不能回复自己的瓶子）、`400 { error_code: 703 }`（非持有者或持有已过期）
  - 若未提供 `reply_to`（发布新瓶）：执行限流与冷却；祝福/诅咒按善恶值判定；设置 7 天时效；成功：`201 Created` → `{ id }`

示例（curl）
```
curl -X POST http://localhost:3000/bottles \
  -H 'Content-Type: application/json' \
  -H 'x-forwarded-for: 11.22.33.44' \
  -d '{
    "item_id":"cb_custom:message_bottle",
    "author":"玩家A",
    "content":"示例内容",
    "kind":"normal",
    "type":"message",
    "replies":[]
  }'
```

示例（PowerShell）
```
$headers = @{ 'x-forwarded-for' = '11.22.33.44' }
$body = @{ item_id='cb_custom:message_bottle'; author='玩家A'; content='示例内容'; kind='normal'; type='message'; replies=@() } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/bottles' -Headers $headers -ContentType 'application/json' -Body $body
```

错误示例（作者当日超 5 次）
```
HTTP/1.1 429 Too Many Requests
{ "error_code": 201 }
```

错误示例（同 IP 当日超 10 次）
```
HTTP/1.1 429 Too Many Requests
{ "error_code": 202 }
```

错误示例（命中 2 分钟冷却，发布新瓶时）
```
HTTP/1.1 429 Too Many Requests
{ "error_code": 301, "retry_after": 120 }
```

错误示例（封禁中）
```
HTTP/1.1 403 Forbidden
{ "error_code": 302, "until": 1730000000000 }
```

## 限流状态查询
- `GET /limits/check?author=<玩家名>`
- 依赖头：`x-forwarded-for`（用于计算 IP 当日计数）
- 响应：`200 OK` → `{ author_count, ip_count, player_cd_until, ip_cd_until, ban_until }`

示例
```
curl -H 'x-forwarded-for: 11.22.33.44' 'http://localhost:3000/limits/check?author=%E7%8E%A9%E5%AE%B6A'
```

## 钓取漂流瓶（临时区）
- `POST /fish`
- Body：`{ player: string }`
- 行为：
  - 若玩家已有待回复的漂流瓶（存在未过期临时持有），拒绝：`429 { error_code: 601, message: "您有待回复的漂流瓶，请先处理" }`
  - 候选集合：主区、未满 5 次回复、**非请求者发布的瓶子**；优先随机获取符合善恶倾向的瓶子，若无则随机获取任意瓶子
  - 创建临时持有 1 小时，并将瓶转入临时区
- 成功：`200 OK` → `{ id, item_id, status, expires_at, bottle }`
  - `status`: `normal` (普通) | `bless` (祝福) | `curse` (诅咒)
  - `item_id`: 瓶子物品 ID
  - `bottle`: 完整漂流瓶对象

示例
```
curl -X POST http://localhost:3000/fish -H 'Content-Type: application/json' -d '{"player":"玩家B"}'
```
响应示例
```json
{
  "id": 1,
  "item_id": "minecraft:stone",
  "status": "bless",
  "expires_at": 1764513657999,
  "bottle": { "id": 1, "bless_curse": "bless", ... }
}
```

## 回复漂流瓶
- `POST /bottles/:id/reply`
- Body：`{ user: string, content: string }`
- 行为：
  - 追加回复并将漂流瓶回主区；`reply_count==5` 转入纪念区并记录参与者
- 成功：`200 OK` → `{ ok: true }`
- 要求：必须是该瓶的临时持有者（未过期）且不是作者本人
- 错误：`429 { error_code: 501 }`（已达 5 次）、`404 not_found`、`400 { error_code: 701 }`（回复内容为空）、`400 { error_code: 702 }`（不能回复自己的瓶子）、`400 { error_code: 703 }`（非持有者或持有已过期）

示例
```
curl -X POST 'http://localhost:3000/bottles/1/reply' -H 'Content-Type: application/json' -d '{"user":"玩家C","content":"回复内容"}'
```

## 纪念区与捞瓶
- `GET /memorials`
- 响应：`200 OK` → `[{ bottle_id, participants, created_at }]`

- `POST /dredge`
  - Body：`{ user: string, id: number }`
  - 条件：仅作者或曾参与回复的玩家可以捞取纪念册；目标瓶必须处于纪念区
  - 成功：`200 OK` → `{ bottle, replies }`
  - 错误：`403 { error: 'forbidden' }`、`404 { error: 'not_found' }`、`409 { error: 'not_memorial' }`

示例
```
curl -X POST 'http://localhost:3000/dredge' -H 'Content-Type: application/json' -d '{"user":"玩家C","id":1}'
```

## 临时区释放/消耗
- `POST /holds/:id/release`
  - 行为：释放临时持有并让瓶回到主区
  - 成功：`200 OK` → `{ ok: true }`

- `POST /holds/:id/consume`
  - 行为：查阅并消耗，释放持有资格（回主区）
  - 成功：`200 OK` → `{ ok: true }`

- `POST /holds/release-player`
  - Body：`{ player: string }`
  - 行为：批量释放该玩家的所有持有
  - 成功：`200 OK` → `{ released: number }`

示例
```
curl -X POST 'http://localhost:3000/holds/release-player' -H 'Content-Type: application/json' -d '{"player":"玩家B"}'
```

## 捞回（发送者）
- `POST /bottles/:id/retrieve`
- Body：`{ user: string }`
- 行为：作者可捞回；当前接口仅回滚善恶值（根据瓶类型），返回 `{ ok: true }`

示例
```
curl -X POST 'http://localhost:3000/bottles/1/retrieve' -H 'Content-Type: application/json' -d '{"user":"玩家A"}'
```

## 善恶值
- `GET /players/:id/morality` → `{ id, morality }`
- `POST /players/:id/morality/apply`（Body：`{ delta: number }`） → `{ id, morality }`

示例
```
curl 'http://localhost:3000/players/%E7%8E%A9%E5%AE%B6A/morality'
```

---

## PowerShell 示例汇总（Windows）
- 创建漂流瓶
```
$headers = @{ 'x-forwarded-for' = '11.22.33.44' }
$body = @{ item_id='cb_custom:message_bottle'; author='玩家A'; content='示例内容'; kind='normal'; type='message'; replies=@() } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/bottles' -Headers $headers -ContentType 'application/json' -Body $body
```
- 钓取 → 回复
```
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/fish' -ContentType 'application/json' -Body (@{ player='玩家B' } | ConvertTo-Json -Compress)
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/bottles/1/reply' -ContentType 'application/json' -Body (@{ user='玩家B'; content='回复内容' } | ConvertTo-Json -Compress)
```
- 查询列表与详情
```
Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/bottles?limit=50&area=main' | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/bottles/1' | ConvertTo-Json -Depth 4
```
- 限流状态
```
Invoke-RestMethod -Method Get -Uri 'http://localhost:3000/limits/check?author=%E7%8E%A9%E5%AE%B6A' -Headers @{ 'x-forwarded-for' = '11.22.33.44' }
```
