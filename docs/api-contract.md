# 主星上的大肥鱼 · Host ↔ 面板 HTTP 契约（v1）

> 归属：xingzhu。所有路由都挂在 DSH 的 `webServer` 上，前缀固定 `/api/qq-fish`；
> 面板（client.js）只通过同源 `fetch` 取数，不依赖任何 `@deepseek-ai/*` 包。
> 所有响应都是 JSON：`{ ok: true, ... }` 或 `{ ok: false, error: "人话" }`。

## 0. 约定

- Host 是唯一真相源：配置、桥状态、登录态、聊天记录、token 用量都从 Host 取；
- 面板每 2.5~3 秒轮询一次 `GET /state`；用户点按钮后立刻再拉一次；
- 所有错误都返回人话 `error`，面板直接展示，不猜技术细节；
- 敏感字段只出脱敏值：QQ 号一律 `12****78` 形态；token / Credential 永不出现在响应里。

## 1. `GET /state` — 面板唯一主数据源

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "home": "C:\\Users\\<user>\\.dsh\\qq-fish",
  "now": 1792945894333,
  "config": {
    "personaName": "小肥鱼",
    "persona": "……（人设原文）",
    "wsUrl": "",              // 进阶路径才需要
    "hasToken": false,        // wsToken 是否有值（明文永不回显）
    "hasWebuiToken": false,   // 进阶路径 WebUI token 是否有值
    "autoStart": true,        // DSH 重启后自动拉起托管 NapCat
    "onebotMode": "managed",  // managed | external
    "webuiUrl": "",           // 仅 external 模式用
    "autoReply": false,
    "groupReplyMode": "mention",   // mention | smart | all（群聊接话方式）
    "groupKeywords": "",           // smart 模式的兴趣关键词（逗号/换行分隔，可空）
    "groupSmartJudge": true,       // smart 模式先让模型判断要不要插话
    "groupMinIntervalSec": 120,    // 同一个群两次接话最短间隔（秒）
    "groupMaxPerHour": 6,          // 同一个群每小时最多接几句（0=不接非 @ 话题）
    "groupReplyChance": 100,       // 候选接话概率（0-100）
    "autoReplyGroups": false,      // 兼容旧字段，新配置请用 groupReplyMode
    "pushEnabled": false,
    "whisperEnabled": false,
    "privacyMode": true,
    "activeStart": 9,
    "activeEnd": 23,
    "pushMinIntervalMinutes": 90,
    "whisperMinIntervalMinutes": 45,
    "maxReplyChars": 400,
    "maxProactivePerHour": 4,
    "pushOnlyAfterTalk": true,
    "pushTarget": null,       // {kind,id,name} | null
    "whisperTarget": null,
    "modelProvider": "",
    "model": "",
    "account": { "uin": "12****78", "nickname": "小肥鱼" }  // 脱敏展示
  },
  "provision": {
    "mode": "none",           // none | managed | external | ready
    "qq": { "installed": true, "path": "C:\\Program Files\\Tencent\\QQNT\\QQ.exe" },
    "napcat": {
      "installed": false, "running": false, "version": "", "dir": "",
      "webuiPort": 0, "onebotPort": 0, "managed": true, "lastError": ""
    },
    "installJob": { "state": "idle", "stage": "", "percent": 0, "log": "" } // idle|running|done|failed
  },
  "login": {
    "phase": "idle",          // idle|need_provision|waiting_qrcode|generating_qrcode|qrcode_scanned|initializing|ready|offline|reconnecting|error
    "isLogin": false,
    "isOffline": false,
    "qrDataUrl": "",          // data:image/png;base64,... （有码时才有）
    "qrText": "",             // 备用：纯文本 URL（前端兜底展示/终端排查）
    "error": "",
    "account": null           // {uin:"12****78", nickname, avatarUrl}
  },
  "bridge": {
    "state": "idle",          // idle|connecting|online|reconnecting|error
    "detail": "还没连 QQ 桥",
    "lastError": "",
    "selfId": "12****78",
    "nickname": ""
  },
  "scheduler": {
    "push": { "lastAt": 0, "nextAt": 0 },
    "whisper": { "lastAt": 0, "nextAt": 0 },
    "quietNow": false
  },
  "stats": {
    "today": { "received": 0, "sent": 0, "replies": 0, "llmCalls": 0 },
    "lifetime": { "received": 0, "sent": 0, "replies": 0, "llmCalls": 0 }
  },
  "safety": { "acknowledged": false },
  "usage": {
    "today": { "input": 0, "output": 0, "calls": 0 },
    "lifetime": { "input": 0, "output": 0, "calls": 0 }
  }
}
```

> `config` 里不含明文 `wsToken` / WebUI token；只给 `hasToken`。保存 token 用
> `POST /config {patch:{wsToken:"..."}}`，Host 写本地文件且不在任何响应/日志里回显。

## 2. 配置

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| POST | `/config` | `{patch:{...}}`（只认白名单键） | `{ok, config}` |
| POST | `/persona/reset` | `{}` | `{ok, config}`（恢复出厂人设） |
| POST | `/safety/ack` | `{acknowledged:true}` | `{ok, safety}` |

## 3. NapCat / 桥接托管

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| POST | `/provision/install` | `{asset?:"NapCat.Shell.zip"\|"NapCat.Shell.Windows.Node.zip"}` | `{ok, jobId}`；异步下载安装（进度看 `/state` 的 `provision.installJob`；下载失败会自动换源：`config.napcatMirror`（若填）→ GitHub 直连 → gh-proxy.com → ghproxy.net） |
| POST | `/provision/start` | `{}` | `{ok}`；启动 NapCat（已装才可）。本机 QQ 在跑且用 Shell 包时返回 `code:"qq-running"` |
| POST | `/provision/kill-qq` | `{}` | `{ok, killed, started, error?}`；只结束插件探测到的那份 QQ.exe，然后尝试启动 NapCat |
| POST | `/provision/stop` | `{}` | `{ok}`；停止插件拉起的 NapCat |
| POST | `/provision/cancel-install` | `{}` | `{ok, cancelled, jobId?, note?}`；取消正在进行的 NapCat 安装，任务落 `installJob.state="cancelled"` |
| POST | `/provision/detect` | `{}` | `{ok, provision}`；重新探测 |
| POST | `/provision/use-managed` | `{}` | `{ok, provision}`；从外部 NapCat 切回插件托管（清空外部地址） |
| POST | `/provision/setup-external` | `{wsUrl, wsToken?, webuiUrl?, webuiToken?}` | `{ok, provision}`；进阶路径：用户已有 NapCat（`wsUrl` 必填，空地址返回 `invalid-external`） |

## 4. 扫码登录

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| POST | `/login/start` | `{}` | `{ok, phase, qrDataUrl?, qrText?, error?}` |
| POST | `/login/refresh` | `{}` | `{ok, phase, qrDataUrl?}` |
| POST | `/login/poll` | `{}` | `{ok, isLogin, isOffline, phase, loginPhase, error, account?}` |
| POST | `/login/quick` | `{uin:"123456"}` | `{ok, phase}` |
| GET | `/login/quicklist` | — | `{ok, items:[{uin:"12****78", id:"12345678", rawUin:"12345678", nickname, avatarUrl}]}`；`/login/quick` 用 `id`/`rawUin` 的明文 |

登录成功后 Host 自动连 OneBot WS（`/state.bridge.state` 变 `online`），不需要用户再操作。

## 5. 聊天记录

| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | `/chats` | — | `{ok, conversations:[{key:"private:123", kind, id:"123", idMasked:"12****78", name, lastText, lastTs, count}]}`；`key` 含真实 id，供 /messages、/send、推送目标复用；按 lastTs 倒序 |
| GET | `/messages` | `?conversation=private:123&limit=200` | `{ok, messages:[{ts, direction:'in'|'out', who, text, masked:boolean, kind?, usage?}]}` |
| POST | `/send` | `{kind:'private'|'group', id:"123", text:"..."}` | `{ok, messageId}` |
| POST | `/contacts/sync` | `{}` | `{ok, friends:0, groups:0}` |

> 聊天记录来自本机 `messages.jsonl`（Host 写入，时间戳来自 OneBot 事件 `time`）。
> `privacyMode=true` 时 text 内手机号/身份证打码，QQ 号仍以脱敏 id 展示。

## 6. 主动推送 / 碎碎念

| 方法 | 路径 | body | 返回 |
|---|---|---|---|
| POST | `/push/now` | `{target?:{kind,id,name}}` | `{ok, text?, skipped?, error?}` |
| POST | `/whisper/now` | `{}` | `{ok, text?, skipped?, error?}` |
| POST | `/emergency-stop` | `{}` | `{ok}`；断 WS + 停 NapCat + 停定时器（保留数据） |

## 7. token 用量

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/usage` | `{ok, today:{input,output,calls}, lifetime:{input,output,calls}, days:[{date,input,output,calls}], recent:[{at,kind,input,output,model}]}` |

> 口径：只统计**小肥鱼自己发起的 LLM 调用**（自动回复、主动推送、碎碎念），
> 不含用户在对话页里的消耗；数据来自 `dsh-llm` 的 `usage` chunk（input 含 cache 读写）。
