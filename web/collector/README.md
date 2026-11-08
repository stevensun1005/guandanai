# 真人联机牌谱云端接收

GitHub Pages 继续承载游戏。这里的独立 Cloudflare Worker 把结束后的结构化牌谱存进 D1；电脑关机不影响接收。网页不持有 Cloudflare 管理凭据或导出密钥。

## 采集条件

- 仅房主采集，发牌及正式开打时至少有两名真人。
- 每把结束才提交；单人局、只有一名真人的房间、加入者、明牌练习和未完成的牌局不提交。
- 开始后断线或超时按每个动作的实际来源区分 `human`、`bot`、`timeout`；转为单机后不再提交该把。
- 正常页面写 `kind=game`，诊断页面 `?test=1` 写 `kind=test`。测试数据默认不导出到训练原始目录。

大厅不再显示采集短说明，牌桌「选项」仍显示上传状态；完整约定见本文。本站记录不包含昵称、房间号、聊天、语音、座位恢复凭据或 IP。四个随机座位 ID 仅在同一整场中稳定，不能用来识别跨房间的个人。

例外：Clint 的网站（`appVersion` 以 `c1977` 开头）会附带可选的 `room`（房间号）和 `seats[].name`（真人昵称，电脑座位为 `null`）。本站自己的记录不带这两个字段。它们只存在原始牌谱里，`human-examples.mjs` 生成的训练样本不包含。

## 机器格式

每局一条 JSON：

| 字段                                       | 内容                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `schema / encoding / appVersion`           | 协议版本、108 张实体牌编码、网页构建版本                               |
| `id / matchId / round`                     | 整场随机标识和把数，上传重试复用同一 ID                                |
| `match / rules / level / leader`           | 开局级数、A 次数、桌规和首出方                                         |
| `dealtHands / hands / tribute`             | 发牌后及进还贡后的四手牌，实际交换                                     |
| `seats / humanMask`                        | 匿名座位、初始真人状态、电脑 ID／版本／完整权重 SHA                    |
| `room / seats[].name`                      | 可选；房间号（≤16 字）与真人昵称（≤24 字），首尾不能有空白或控制字符   |
| `actions`                                  | 所有出牌和过牌、牌型、操作者来源、当时真人掩码、托管模型和主机观测时间 |
| `order / result / levelsAfter / remaining` | 名次及服务端重算的结算和余牌                                           |

牌用 `core/cards.js` 的 `makeDeck()` 下标 0–107 表示，花色、点数、重复牌和百搭均可精确恢复。`decisionMs` 取房主当前计时器已消耗时间，包含网络影响，不声称是精确的人类思考耗时；`elapsedMs` 使用单调时钟。进还贡保存交换事实，不将自动选择误作人工进还贡学习样本。

服务端重放全部动作，核对 108 张牌守恒、出牌权、压制、过牌、接风、终止名次和升级。每把以唯一 ID 和内容 SHA 去重；冲突返回 409，禁止覆盖。浏览器只有收到 `stored=true` 后才删除 IndexedDB 待上传记录；断网、接口失败或关闭后重开会继续补传。浏览器禁止本地存储时仅能保留当前页面内存，会显示待同步／暂存不可用。

## 云端与私有导出

配置在 `wrangler.jsonc`，SQL 迁移在 `migrations/`。命令使用 Wrangler **4.158.0**；OAuth 至少需要 `account:read`、`user:read`、`workers_scripts:write`、`d1:write`。旧的 `workers:write` 不能替代本版部署所需的 Scripts 权限。

```powershell
npx wrangler@4.158.0 d1 migrations apply DB --remote --config web/collector/wrangler.jsonc
npx wrangler@4.158.0 deploy --config web/collector/wrangler.jsonc
# 通过标准输入设置私有 EXPORT_TOKEN，不写进 Git 或前端。
npx wrangler@4.158.0 secret put EXPORT_TOKEN --config web/collector/wrangler.jsonc
```

公开接口仅有 `POST /rounds` 与不含数据的 `/health`。指定网页 Origin、98,304 字节上限、每来源 IP 60 次／分钟限流和严格字段白名单共同约束写入；原始 IP 不写入数据库。`GET /admin/export` 必须提供私有 Bearer 密钥，每页最多 100 局，默认排除测试局。匿名访问没有牌谱列表或下载权限。

当前 D1 为 `guandan-human-games-v1`，接收服务为 `guandan-human-games-collector`。允许正式 GitHub Pages 来源、Clint 网站 `https://clintsun1977.github.io` 及本机 `127.0.0.1:8765`／`localhost:8765` 预览；更换域名时需要同时修改来源清单、网页配置与 CSP，再部署验证。

[Clint 的掼蛋网站](https://clintsun1977.github.io/guandan/)使用同一格式上传两名以上真人的牌谱，与本站记录同库导出、同样经服务端重放校验。其 `appVersion` 以 `c1977` 开头，电脑 ID 沿用本项目发布编号（danMCai `017`、GuanZero `021`），Clint 规则为 `clint-rule`、版本 `clintsun1977-…`；需要区分来源时按 `appVersion` 前缀筛选。采集代码见 [clintsun1977/guandan `web/src/collection/`](https://github.com/clintsun1977/guandan/tree/main/web/src/collection)。

在项目根目录：

```powershell
node ai/shared/data/tools/fetch-human-games.mjs
node ai/shared/data/tools/prepare-human-games.mjs
```

导出密钥默认读取忽略的 `ai/danMCai/workspace/collection/export-token.txt`，也可通过 `GUANDAN_EXPORT_TOKEN` 或 `--token-file=...` 提供。原始文件位于忽略的 `ai/shared/data/human-games/raw/round-000000000001.json`，学习样本位于 `ai/shared/data/human-games/prepared/examples.jsonl`。密钥不放进网页、命令参数或文档；密钥丢失可重新设置，数据库数据不受影响。

诊断时显式传入 `--include-tests`，默认另存 `ai/danMCai/workspace/collection/export-validation/`，不会混入正常原始目录。预处理即使读取该诊断目录，也会排除 `kind=test`。工具按每局处理并写入临时文件，完成后替换样本文件，避免将全部历史动作同时放进内存。

## 研究边界

合法牌局与真实人类身份是两个问题。无账号朋友房间的操作者来源由房主报告，因此保存 `trust=unverified_browser`；公开写入接口不能证明一定是两名不同的人。原始数据先隔离归档，不能直接接进当前冻结训练或独立验收。预处理只提取 `actor=human`，排除电脑、超时托管和测试局；每个样本只暴露当事人手牌、其他玩家公开张数和此前公开出牌，不暴露其他三手私牌。训练／验证／测试按整个 `matchId` 固定分组，避免同场跨集合泄漏。

这次功能只采集和准备数据，没有运行梯度训练，也不保证模仿人类选择必然提高胜率。以后训练还需单独实验、对手评测与冠军筛选。

### 可选的预评展示标记

`actions[].assisted` 是向后兼容的可选布尔字段，仅允许人工动作携带；`true` 表示本手提交之前浏览器展示过冠军数字预评，不证明玩家读过或采纳。开关打开但未显示分数、加载失败与仅事后评价不算。房主许可与本人开关独立，网络事件传递此标记，原始牌谱保留；默认 `human-examples.mjs` 排除 `assisted=true`。旧记录未包含此功能，不改写历史内容。发布先更新接收 Worker 的白名单，再更新 Pages。[评价入口](../docs/MOVE_COACH.md)。

## 跨次继续整场

大厅「继续上一场」只恢复最近一次完整结束后的级数、打A失败次数／一次不过状态、上一局名次与匿名整场编号；不恢复中途手牌或旧房间连接。仅在本人主动继续且初始状态／牌规匹配时复用ID，局号从原序号继续。匿名席位ID按固定方位轮换，不能据此认证真人身份；原房间中途断线仍用原座位恢复入口。

本机记录最长30天，只保存进度／匿名ID，不保存昵称、私牌或座位密钥；练习／加入者不写此进度。房主明牌排除位随续场保留，不能刷新或换游戏对象恢复采集。收藏器仍仅在联机至少两名真人、完整合法局结束后排队；合成测试和 assisted 标记保持，真人数据不接训练。
