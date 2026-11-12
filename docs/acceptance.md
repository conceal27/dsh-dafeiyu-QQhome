# 主星上的大肥鱼 · 需求验收对照表（归属：xingzhu）

> 对应本轮目标里的 9 条需求，逐条给出「实现位置 + 已验证证据 + 未覆盖说明」。
> 证据截图在 `_research/shots/`，验证记录在 `_research/verification-log.md`。

| # | 需求 | 实现 | 验证证据 | 状态 |
|---|---|---|---|---|
| 0 | 对外发布；新手点左上角「插件」→「添加插件」即可 | npm 规范包（`dsh.bundle.patch` + `dsh.client` + locale/icon）；tarball / 本地路径 / npm 包名三种安装方式 | 真机：插件页 → 添加插件 → 本地路径 → 安装成功 → 立即启用（`install-result.png`）；tarball 装进全新 profile 后插件正常启动；`pnpm publish --dry-run` 通过，包名未被占用 | ✅ |
| 1 | 启动后有单独面板：连接状态 / 登录账号 / token 消费 / 小肥鱼名字（命名是人设一部分） | 左栏独立面板（`main` + `sidebar.panellist`）；概览含桥状态、账号脱敏、今日/累计 token；人设页有「小肥鱼的名字」并注入系统提示词 | `panel-overview.png`、`panel-real-llm-usage2.png`、`panel-real-llm-chat.png`（真实模型回复 + 116 tok） | ✅ |
| 2 | 人设设定，默认人设按用户原文 | `lib/persona.mjs` 的 `DEFAULT_PERSONA` 原文内置；`systemPrompt()` 含名字 + 人设 + 硬规则（口语短句/不卖萌/emoji≤1/不编造） | 真实 deepseek-flash 回复符合人设：「在，游戏就《博德之门3》值得砸时间…」；人设页 `panel-persona.png`；重置出厂人设接口 | ✅ |
| 3 | 可以通过 QQ 聊天；聊天记录在面板显示且有时间戳 | OneBot 11 WS 收发（`lib/onebot.mjs` / `lib/engine.mjs`）；记录落 `messages.jsonl`（事件 `time` → 毫秒时间戳）；面板会话列表 + 气泡 + 分钟级时间戳 + 日期分隔 | 真机假桥：收消息 → 自动回复 → 面板显示（`ui-chat-send.png`）；手动发送框 → 假桥收到 `send_private_msg`；真实手机 QQ 收发待用户扫码后验证 | ⏳ 代码/假桥已验证，真 QQ 待用户 |
| 4 | 数据脱敏、安全守则 | 面板 QQ 号一律 `12****78`；手机号/身份证展示打码；token 不写日志/不回显；本地 127.0.0.1 + 随机 token；风险确认前置闸门（未确认不记录不回复）；主动推送频控/安静时段 | `client-smoke` 42→52 条断言含脱敏；`integration-engine` 安全闸门用例；`SECURITY.md`；`panel-safety-jump.png` | ✅ |
| 5 | 参考 q.qq.com 文档 | 调研结论：官方机器人是独立 bot 账号，不能扫码登录用户 QQ、无好友/历史记录接口、主动推送已收敛 → 不满足需求；因此选 NapCat+OneBot（社区协议端）并在文档/面板明示风险（`docs/install-guide.md` 有说明） | `_research/qq/official-bot-v2.md`、`qq-integration.md` | ✅ 已参考并给出取舍 |
| 7 | 可主动向 QQ 推送消息；有「碎碎念」（按人设） | 主动推送 + 碎碎念双定时器（间隔/小时上限/安静时段/防骚扰默认值）；面板「现在发一条 / 现在来一条碎碎念」 | 真实模型生成并发出（假桥抓包）：推送「凌晨了还没睡呢…」、碎碎念「凌晨一点四十五…」；`ui-push-now.png`、`ui-whisper-now.png`；修复 user_id 丢失回归 | ✅ |
| 8 | 面板功能合理分布，小白不迷路 | 四个一级标签：概览（状态+向导+二维码）/ 聊天 / 人设 / 推送与安全；高级项折叠；900px 窄屏单列自适应；二维码大图 240px | `panel-overview.png`、`ui-narrow-900.png`；面板冒烟 52 条渲染断言 | ✅ |
| 9 | 首次使用引导：扫码登录 → 功能正常运作 | 四步向导（装桥→扫码→人设→开开关）自动点亮；「关闭 QQ 并继续」；安装进度条；快速登录列表；登录后自动连桥 | `panel-wizard-fixed.png`、`panel-qr-live-2.png`（真实二维码）、`panel-qqrunning-fixed.png`；真实 NapCat 4.18.41 安装+启动+WebUI 鉴权+二维码全链路 | ✅ 到二维码；扫码后由用户完成 |

## 自动化测试矩阵

| 套件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/pure-logic.test.mjs` | 49 | store/persona/redact/usage/engine/push/llm/onebot 纯逻辑 |
| `tests/client-smoke.mjs` | 52 | 面板 classic script 契约、slot 注册、路由覆盖、空/满/脏数据渲染、向导与提示逻辑 |
| `tests/napcat.test.mjs` | 23 | WebUI 鉴权/Credential 缓存/错误映射、配置写盘、安装/启动守卫、二维码 PNG 校验 |
| `tests/integration-engine.mjs` | 15 | 收消息→人设→真 dsh-llm→回复→记录/用量；安全闸门 |
| `tests/integration-bridge.mjs` | 11 | 假 OneBot WS：握手/登录/收发/会话/脱敏/快照/推送 user_id 回归 |
| `tests/integration-reconnect.mjs` | 5 | 断线→reconnecting→自动重连→重连后继续收发 |

## 用户侧待完成（无法由 agent 代替）

1. 完全退出并重开 DSH（让桌面版 profile 加载本插件），手机扫码登录真 QQ；
2. 真好友/群聊收发、真 QQ 上的主动推送/碎碎念到达效果；
3. 如要发布 npm：需要账号持有人 `npm login` 后执行 `pnpm publish`（见 `publish-checklist.md` §9）。
