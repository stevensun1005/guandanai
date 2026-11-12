# 029底座尾盘迁移：Windows实际运行交接

2026-11-12所有者已选择“r2相对017的权重增量迁到新冠军、新Adam”。本批已经启动，当前读实时文件；原017续训协议未启动并按历史保留。本文件不要求重新启动窗口。

- 网页冠军为029 / danMCai-v000061013，Pages已上线；旧reason9001仍为017底座归档。新尾盘学生不自动部署。
- 训练源码冻结在 `ai/danMCai/workspace/worktrees/endgame-rebase-029-runtime-20261112`（实际物理目录为 `ai/local/workspace/worktrees/endgame-rebase-029-runtime-20261112`），提交 `1415fac1bfa65abe050c4750e69215a77764d474`。不要同步这个冻结检出。
- 完整协议和固定租期已先推main `2fadfb7`，见[完整协议](protocol.json)、[注册](registration.json)、[真实启动](startup.json)。运行目录 `ai/danMCai/runs/endgame-rebase-029-20261112`；只读统一面板 <http://127.0.0.1:8767/>。

## 原件与迁移

原包在 `C:/Users/Admin/Downloads/endgame-r2-e00061050.zip`，5个文件SHA均通过；解包原件保留在忽略的 `ai/danMCai/workspace/transfer/endgame-r2-20261112`。原检查点d42fb020…、原学生382085ee…；原包、旧回放与旧运行不覆盖。

12组主干按 `029 + (r2 - 017)` 在float64计算后转float32，162×512 oracle投影保留；生成的新检查点b58d9168…、初始学生4083bc39…。这是实验性参数迁移，非原Adam逐位续训；新Adam为空、回放为空。历史计数61050保留，新增更新必须扣除此数，旧累计训练/摄入行另记在inherited。oracle keep从开始就是0，不使用真人/D1数据。原r2的成绩不能套到迁移初始或新最终学生。

## 固定时间与资源

| 项目 | 多伦多（美东） | UTC |
| --- | --- | --- |
| 注册窗口起点 | 11月12日11:58:54 | 2026-11-12T16:58:54.268Z |
| 实际控制器启动 | 11月12日11:59:24 | 2026-11-12T16:59:24.245Z |
| 停止训练 | 11月13日03:58:54 | 2026-11-13T08:58:54.268Z |
| 停止新增评测 | 11月13日06:58:54 | 2026-11-13T11:58:54.268Z |
| 保存窗口结束 | 11月13日07:13:54 | 2026-11-13T12:13:54.268Z |

4个演员上限、4GiB暂停/5GiB恢复，750k回放，batch2048、lr1e-5、ROCm的cuda接口。replayRatio配置4，沿用r2在每50次更新后检查的实现；短期可多出最多102400训练行，原始计数不调整。内存暂停会释放本批演员进程，未刷盘的局部行从最后已刷盘种子游标重采，不宣称精确恢复未保存的RNG/淘汰回放。临时SYSTEM_REQUIRED只在本窗口存续，无永久电源设置修改。

原Mac预留种子在Windows审计被拒，[原始拒绝记录](original-windows-audit-rejection.json)保留。新批按实际 `createRound(seed)` 的literal单局语义审计2M新训练副/3000留出副，见[种子证据](seed-audit.json)；不虚构新literal种子各自完成200派生局。

## 自动阶段与结果

控制器 `endgame-transfer-window.mjs` 使用本批registration/guardian和STOP。正式训练结束后自动核对所有本批相关进程退出，核验最终网络/13组Adam/保留与累计分片/待摄入行，再取窗口最终导出。

同3000独立牌副，每副交换阵营两局，三组分别是A最终尾盘学生、B迁移初始学生、C原r2学生，均在029开局/对手条件下评测。A均值95%牌副簇区间为主；A−B区分后续训练效应，A−C与B−C按名义95%区间描述，不宣称多重比较家族显著或整体最强。截断报错、未完成对丢弃，未满3000副须标部分结果，不扩样补救。

- 实时状态：`progress.json`、`train/status.json`、`train/learner/status.json`、`train/actors/slot-*.json`。
- 停止审计：`stop-audit.json`、`process-exit-audit.json`、`final-model.json`。
- 各组结果：`eval-A`、`eval-B`、`eval-C` 的 `run.json`、`summary.json`、`part-*.json`。
- 配对差与完整性：`results.json`；`FINISHED`与`awake-status.json`分别记录结束及电源请求释放。

取消整个窗口时在运行根目录写 `STOP`，守护会通知训练停止，后续评测不再开启；只写 `train/STOP` 属于结束训练阶段，随后仍可能进入评测。不要凭旧PID杀进程；Windows探活用Node `process.kill(pid,0)`，活PID还要核对命令范围，Python redirector父子是一个逻辑学习器。

故障时保留 `failure.json`、STOP、原注册、权重/优化器/数据和日志；不要删除锁或注册后盲目重开。恢复只使用原截止的剩余时长，源码/协议修订另记，其他机器和旧冻结运行不动。权重/完整回放不进Git；有结论时将小证据与正负结果更新主报告并按仓库检查流程推main。

运行注记：曾发生一次Windows状态JSON原子替换读锁冲突（WinError5），原监督器在原截止内从已保存网络/Adam恢复，冻结源码不变；具体锁持有者未核实。实时监看使用现有Node API或Node fs读取，避免长时间占用活动JSON文件。旧失败日志保留，未保存的RNG/完整回放不算已恢复；见[runtime-note-1](runtime-note-1.json)。
