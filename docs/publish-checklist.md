<!-- 归属：xingzhu · 适用版本：0.1.x -->
# 主星上的大肥鱼 · 发布前检查单

发布 = 把 `dsh-dafeiyu-home` 这个 bundle 推到 npm（或 GitHub Release 的 tarball），
让用户在 DSH「插件」页能一键装上。**发布动作要人来做**（npm 账号、2FA、GitHub 发版），
这份清单把「发之前必须确认什么」列全，照着勾即可。

> 约定：`<profile>` 换成你的目标 profile（桌面版常见 `desktop`，浏览器版 `web`，
> 隔离测试用 `scratch` 之类）。`<repo>` 换成真实仓库地址（**发布前补上**，见 §12）。

---

## 0. 发布阻塞项（当前版本必须全部清零）

- [ ] `docs/api-contract.md` 里的所有路由都已在 `index.js` 实现，且返回形状与契约一致
      （`/state`、`/usage`、`/chats`、`/messages`、`/send`、`/contacts/sync`、
      `/config`、`/persona/reset`、`/safety/ack`、`/provision/*`（含 `kill-qq`、`install`
      的 `{asset?}`）、`/login/*`、`/push/now`、`/whisper/now`、`/emergency-stop`）
- [ ] `lib/napcat.mjs`、`lib/webui.mjs` 已随包（托管安装、镜像回退、WebUI 自动化依赖它们）
- [ ] `client.js` 完成版面板已合入，包含：概览/聊天/人设/推送与安全、二维码、
      安装进度与日志、下载镜像填写、QQ 在跑时的「关闭 QQ 并继续」、紧急停止、token 用量
- [ ] 所有测试文件齐全并全绿（见 §3）
- [ ] `README.md` / `SECURITY.md` / `LICENSE` 与代码实际行为一致（默认值、路径、限制、
      下载镜像机制与「关闭 QQ 并继续」的边界）
- [ ] 仓库地址、Issue 入口已补进 `SECURITY.md` §10 与 `package.json`（`repository` 字段，
      带 `directory` 时指向子目录）

---

## 1. 版本与元信息

- [ ] `package.json` 的 `version` 已从上一版递增（语义化：修复 = patch，功能 = minor，
      破坏性 = major；0.x 阶段 minor 也可放功能）
- [ ] `description` 一句话准确（不夸大、不写「官方」）
- [ ] `keywords` 含 `dsh` / `dsh-plugin` / `deepseek-harness` / `qq` / `onebot` / `napcat`
- [ ] `author` = `xingzhu`，`license` = `MIT`
- [ ] `type` = `module`，`main` / `exports` 指向真实存在的文件
- [ ] `dsh.bundle.patch` 指向 `./cordis.patch.yml`，且该文件里的行 id（`qq-fish`）
      与 `index.js` 的 `name` 一致
- [ ] `dsh.client` 的 `platform` / `immediately` / `inject` 未被误改
- [ ] **不要**加 `engines.dsh` 或 `peerDependencies` 里的 `@deepseek-ai/*`
      （纯 JS 插件不写才不触发版本闸门；当前实现只用 `ctx` 服务）
- [ ] `README.md` 顶部「适用版本」与实际验证的 DSH 版本一致

## 2. 包内容（files 白名单）

- [ ] `files` 只列需要发布的文件；两种打包方式任选，逐条核对清单：

```powershell
# 方式 A：有 npm 的机器
npm pack --dry-run
# 方式 B：本仓库自带（没有 npm 也能打）
node scripts/pack.mjs        # 产物：dist\dsh-dafeiyu-home-<version>.tgz，清单 dist\files.txt
```

> 本机 agent 环境没有 npm（node 是外部工具自带的），打包用 `scripts/pack.mjs`；
> 它的逻辑与 `package.json` 的 `files` 白名单一致，`dist/` 自身不会进包。

必须包含：

- [ ] `index.js`、`client.js`、`lib/`（全部 `.mjs`）
- [ ] `cordis.patch.yml`
- [ ] `locale/zh.json`、`locale/en.json`
- [ ] `icon.svg`
- [ ] `README.md`、`SECURITY.md`、`LICENSE`
- [ ] `docs/`（`install-guide.md`、`publish-checklist.md`、`api-contract.md`）

必须不包含：

- [ ] `tests/`、`node_modules/`、`.git/`、临时文件、日志、截图
- [ ] 任何真实 QQ 号、token、`DSH_HOME` 本机路径、二维码图片
- [ ] （可选）确认 `docs/` 是否要随包；若不想让 npm 包变大，从 `files` 移除并同步改
      README 里的链接

安全扫描（发布前**必须**跑，肉眼 + 命令）：

```powershell
# 在包目录里找疑似凭据 / 真实号段（命中要人工确认）
Select-String -Path index.js,client.js,lib\*.mjs,*.md,docs\*.md `
  -Pattern 'access_token|webui_token|Bearer [A-Za-z0-9]|1[3-9]\d{9}' |
  Select-Object Path, LineNumber, Line
```

- [ ] 命中项全部是文档示例/字段名，不是真实凭据
- [ ] `lib/store.mjs` 的默认配置里没有任何真实值（默认 token 一律是空串）

## 3. 静态校验与测试

```powershell
cd dsh-dafeiyu-home
npm run check     # node --check：index/client/bridge/napcat/webui（等价于逐条 node --check）
npm test          # 纯逻辑 55 例 + 面板冒烟 59 断言 + NapCat/WebUI 23 例
```

- [ ] `npm run check` 通过（`client.js` 语法错 = 整页起不来，这条最重要）
- [ ] `npm test` 全绿：`node tests/pure-logic.test.mjs`（55 例）、
      `node tests/client-smoke.mjs`（59 断言）、`node tests/napcat.test.mjs`（23 例）
- [ ] 跑完确认 `%TEMP%` 里没有残留 `dsh-qq-fish-*` / `qqfish-*` 临时目录（测试自清理）
- [ ] 跑完确认真实 `~\.dsh\qq-fish` 的 mtime 没变（测试不能污染真实家目录）

集成测试（会读宿主真实的 `dsh-llm`，必须用 **DSH 自带 Electron 以 Node 模式**跑；
脚本头部也写了命令）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
$dsh = "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
& $dsh tests\integration-engine.mjs     # 21/21
& $dsh tests\integration-bridge.mjs     # 11/11
& $dsh tests\integration-reconnect.mjs  # 5/5（断线 → 自动重连 → 继续收发）
```

- [ ] `integration-engine` 15/15（收消息 → 人设 → LLM → 回复 → 记录/用量落盘；含未确认风险时不记不回）
- [ ] `integration-bridge` 11/11（假 OneBot WS：握手/登录/收发/会话/脱敏/快照不漏 token/推送目标 user_id 回归）
- [ ] `integration-reconnect` 5/5（服务端断开 → reconnecting → 自动重连 → 重连后继续收发）
- [ ] 三个集成都**不联网、不启动 NapCat、不连真 QQ**（用假 ctx.llm / 本地 WS）

## 4. 隔离环境安装 + 组合树校验

```powershell
$scratch = "$env:TEMP\dsh-release-check"
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$env:DSH_HOME = $scratch

dsh --profile web --help                                  # 生成 web profile 模板
dsh plugin --profile web add ~/dsh-dafeiyu-home
dsh --profile web --dump-config | Select-String -Pattern 'qq-fish' -Context 2,4
```

- [ ] `dsh plugin add` 退出码 0，profile 的 `package.json` 多出
      `"dsh-dafeiyu-home": "link:..."`（或版本号）
- [ ] `dsh.profile.bundles` 里有 `dsh-dafeiyu-home`
- [ ] `--dump-config` 能看到 `# == dsh-dafeiyu-home` 和 `id: qq-fish` 行
- [ ] 若从这里替换已安装包，确认已重启 DSH 再测（代码替换不会热加载）

独立 web 冒烟（可选但推荐）：

```powershell
dsh --profile web --no-open --port 14601 --host 127.0.0.1
# 用日志里带 token 的 URL 打开
```

- [ ] `GET /api/qq-fish/health` 返回 `{ok:true,name,version,home}`
- [ ] 页面 boot 图里含本插件（`/plugins/??dsh-dafeiyu-home/client.js&rev=...`）
- [ ] 左栏出现图标，面板能打开（不白屏、不卡启动屏）
- [ ] 关闭进程后 `$env:DSH_HOME` 还原，不污染真实 profile

## 5. 真实桌面版 UI 验证（用户路径）

在**真实桌面版**（`profiles\desktop`）上走一遍用户路径：

- [ ] 「插件」页 →「添加插件」→ 填 npm 包名 / 本地绝对路径 → 安装 → **立即启用**
- [ ] `Ctrl + Shift + R` 强刷后左侧栏出现「主星上的大肥鱼」
- [ ] 面板能打开，四块（概览/聊天/人设/推送与安全）都能切换
- [ ] 未勾风险确认时，安装/登录/推送给出**人话提示**（不是白屏/报错栈）
- [ ] 关掉 DSH 再开：插件仍在、配置还在、面板自动挂载
- [ ] 卸载后图标消失；`qq-fish\` 数据按文档说明手动清理

功能走查（能真机做就真机，至少把不依赖 QQ 的部分点一遍）：

- [ ] 装 NapCat / 启动 / 出二维码 / 刷新二维码
- [ ] 一键安装真实下载：直连 GitHub 成功时一次到位；失败时日志出现「改用下载镜像：xxx」
      并自动重试（`config.napcatMirror` 可提前指定）
- [ ] QQ 在运行时：安装完成后**停在该提示**而不是偷偷杀进程；点「关闭 QQ 并继续」只结束
      探测到的那份 `QQ.exe` 并自动启动；探测不到路径时拒绝动手、提示手动退出
- [ ] 扫码登录 → 账号脱敏展示 → 桥「在线」
- [ ] 私聊收到 → 记录展示（时间戳、入/出分列）→ 自动回复
- [ ] 群聊不 @ 不回；@ 了才回（开「群里也回」时全回）
- [ ] 人设保存 / 恢复出厂
- [ ] 主动推送、碎碎念「现在发一条」（含没目标时的错误提示）
- [ ] 时段/间隔/每小时上限生效（可用临时配置改小来测）
- [ ] token 用量今日/累计/近 14 天有数；口径说明在面板上可见
- [ ] 紧急停止：桥断开、托管 NapCat 停掉、定时器停、数据还在
- [ ] 外部模式：填 wsUrl 能连；插件不会停你自己的 NapCat

> 0.1.0 已实机验证（记录在案，发布前复验一次即可）：NapCat v4.18.41 从 GitHub **直连真实
> 下载 + 解压 + 写配置**成功（34.2 MB Shell 包）；安装完成时本机 QQ 在跑，插件正确停在
> 「需要先退出 QQ」而未杀进程；面板四标签在真实 DSH Web UI 里渲染/轮询/会话气泡/脱敏正常。

## 6. 图标 / locale / 快捷键

- [ ] `icon.svg` 能在插件列表与左栏正常显示（不糊、不变形、深浅色下可辨）
- [ ] `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description` 都存在，
      JSON 合法，中文不乱码
- [ ] 插件列表卡片标题/描述来自 locale；缺字段时回退 `package.json`
- [ ] 面板文案全中文；没有英文占位/`TODO`
- [ ] 当前**没有注册全局快捷键**；若以后加，确认不与 DSH / 浏览器快捷键冲突
      （特别是 `Ctrl+K`、`Ctrl+Shift+P` 这类）
- [ ] 左栏入口 order 不与其他插件打架（当前 `order: 12`）

## 7. 安全复核（逐条对照 SECURITY.md）

- [ ] 日志里搜 `token`：只会出现 `hasToken` / `***`，不会出现明文
- [ ] `snapshot()` / `publicConfig()` 返回里没有 `wsToken` / `webuiToken` 明文
- [ ] `napcat.json` 写盘权限尽量收紧；内容只在本机
- [ ] WebUI / OneBot 只绑 `127.0.0.1`；配置里没有 `0.0.0.0`
- [ ] 下载源符合实现：GitHub Releases + 自动换源（`config.napcatMirror` → 直连 →
      `gh-proxy.com` → `ghproxy.net`）；校验 zip 文件头，系统 tar 可用时预检条目（拒绝 `..` 穿越）
- [ ] 第三方镜像的风险已在 SECURITY/README 写明（不保证完整性、只作兜底）
- [ ] 风险确认闸门生效（未确认不能安装/登录/推送）
- [ ] 「关闭 QQ 并继续」只结束探测到的那份 `QQ.exe`；路径未知时拒绝动手（不会误杀）
- [ ] 脱敏生效：面板/日志里的 QQ 号都是 `12****78`
- [ ] 外部命令全部用 `spawn/execFile` + 参数数组，没有字符串拼接执行
- [ ] 卸载说明完整（用户知道要手动删 `qq-fish\`）

## 8. 文档复核

- [ ] README 的安装方式与真实 DSH 界面一致（插件页「添加插件」接受 npm/本地路径/git/tarball）
- [ ] README / install-guide 的默认值表与 `lib/store.mjs` 的 `DEFAULT_CONFIG` 一致
      （含 `onebotMode` / `autoStart` / `napcatMirror` / `webuiUrl`）
- [ ] README FAQ 的「GitHub 下载慢/中断」答案与 `lib/bridge.mjs` 的换源顺序一致
- [ ] install-guide 的托管目录写的是 `$DSH_HOME/qq-fish/napcat/<版本号>/`（不是 %LOCALAPPDATA%）
- [ ] README 的「已知限制」没有过期项
- [ ] `docs/api-contract.md` 的字段形状与 `lib/bridge.mjs` 的 snapshot 一致（含 `kill-qq`）
- [ ] `SECURITY.md` 的落盘文件清单与 `lib/store.mjs` / `lib/bridge.mjs` 实际写入的文件一致
- [ ] 所有文档头部有 `归属：xingzhu`
- [ ] 文档里没有真实 token / 真实 QQ 号 / 本机绝对路径

## 9. 发布动作（需要人工/账号）

### 9.1 发布到 npm（推荐主渠道）

前置：**需要用户（账号持有者）提供**：

- [ ] 发布机上有 `node` + `npm`（本仓库测试只需要 `node`；`npm pack` / `npm publish`
      需要用户自己的 Node.js 环境，别在没装 npm 的沙箱/CI 里硬发）
- [ ] npm 账号已登录本机：`npm login`（浏览器或 token 方式；2FA 账号需一次性验证码）
- [ ] 账号对 `dsh-dafeiyu-home` 这个包名有发布权限（或已用 `npm owner add` 授权）
- [ ] 确认 `publishConfig.access = "public"`（当前已是）

```powershell
npm whoami                       # 确认登录的是正确账号
npm pack --dry-run               # 再核对一次包内容
npm publish --access public      # 发布
```

本机没有全局 `npm` 时，可直接用 DSH 自带的 Node + pnpm（2026-10-26 已用 `--dry-run` 验过打包流程）：

```powershell
$node = "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
cd ~/dsh-dafeiyu-home
& $node $pnpm publish --dry-run --no-git-checks   # 先演练
& $node $pnpm publish --access public --no-git-checks
```

- [ ] `npm publish` / `pnpm publish` 成功（输出 `+ dsh-dafeiyu-home@0.1.0`）
- [ ] 发布后立刻验证：

```powershell
npm view dsh-dafeiyu-home version dist.tarball
npm view dsh-dafeiyu-home@0.1.0 --json | Select-String -Pattern 'name|version|license'
```

- [ ] 用全新 profile 从 registry 装一次：`dsh plugin --profile <p> add dsh-dafeiyu-home`
- [ ] 拒绝让 agent 代持 npm token；**不要把 token 写进任何文件/对话/日志**

### 9.2 GitHub Release（tarball 备选渠道，适合国内加速镜像）

```powershell
node scripts/pack.mjs                 # 或 npm pack；产物 dsh-dafeiyu-home-0.1.0.tgz
git tag v0.1.0 && git push origin v0.1.0
# 在 GitHub Releases 上传 tgz，写清版本与变更
```

- [ ] tag 与 `package.json` 版本一致
- [ ] tgz 内容与 `dist/files.txt` 一致（25 个文件，不含 tests/dist）
- [ ] Release 附件含 `.tgz`，SHA256 写进 Release 说明
- [ ] 用户可「添加插件」填 tgz 的 https 地址或本地路径安装
- [ ] 国内镜像/代理地址（如有）写进 README FAQ

### 9.3 其它渠道

- [ ] 插件市场索引（若提交）：按市场要求填清单，**包内必须带 `dsh.bundle.patch`**，
      否则安装时会被判 `not-a-bundle`

## 10. 发布后

- [ ] 在干净机器（或新建 profile）按 README 从零走一遍「三步开始」
- [ ] 收集首个 issue 模板（附版本/日志采集说明，提醒不要贴 token）
- [ ] 更新 README 顶部的版本与「已知限制」
- [ ] 记录发布：版本号、日期、变更点、已知问题

## 11. 回滚 / 下线

- 发错版本：`npm deprecate dsh-dafeiyu-home@<坏版本> "原因，请升级到 <好版本>"`
- 严重安全问题：先 `npm deprecate` 全量提醒 + README/SECURITY 顶部加警告，再发修复版；
  必要时 `npm unpublish`（72 小时内、且未被依赖时才可能成功）
- 插件导致 DSH 异常：在 README/SECURITY 写明临时处理（插件页禁用/卸载）

## 12. 发布前需要 Lead / 用户补的东西

- [ ] **npm 账号**（用户名 + 发布权限/2FA）——agent 不能代办
- [ ] **npm / Node 环境**（发布机上能跑 `npm publish`；本机 agent 沙箱里只有 `node`，
      打包/测试用 `node scripts/pack.mjs` + `node tests/*.mjs` 可完成）
- [ ] **仓库地址**（GitHub/Gitee）——填进 `package.json.repository`、README、SECURITY
- [ ] **Issue / 漏洞报告入口**——替换 SECURITY.md 的占位说明
- [ ] **真机验证结论**（Windows 10 & 11 各一次扫码/收发；0.1.0 已验下载/解压/写配置与
      面板渲染，建议再补一次「关闭 QQ 并继续」+ 完整扫码收发）——写进 README「已验证环境」
- [ ] 如定制镜像：确认默认的 `gh-proxy.com` / `ghproxy.net` 在发布时不失效；README FAQ
      与面板提示的文案同步

---

归属：xingzhu · 许可：MIT（见 [LICENSE](../LICENSE)）
