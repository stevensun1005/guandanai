# GuandanAI · 掼蛋朋友局

四人组队的在线掼蛋游戏。支持单人练习、房间邀请、进还贡、升级、手机操作和语音。

**在线玩：https://stevensun1005.github.io/guandanai/**

## 和朋友一起玩

1. 打开网址，输入昵称。
2. 一个人选择「开房间」、选座位，把「复制邀请链接」得到的链接发给朋友。
3. 朋友打开链接，输入昵称、点「进入」并选座位。
4. 房主点「开始」。空位和掉线座位由电脑接管。

电脑默认使用强化学习策略网络，在浏览器后台推理。界面不显示模型选择、名称或运行状态。首次加载需要下载游戏资源；如果加载失败，可以重试，不会悄悄切换成另一种电脑策略。

朋友无需安装任何软件。房主的网页负责推进游戏，因此对局期间请保持房主页面打开。

## 本地开发

需要 Node.js 20+：

```powershell
npm ci
npm run build
npm run dev
```

打开 http://127.0.0.1:8765 ，或双击 `启动预览.cmd`。

## GitHub Pages 发布

项目使用 `.github/workflows/pages.yml` 自动构建和发布。向 `main` 推送代码后，GitHub Actions 会安装依赖、构建 `dist` 并部署到 GitHub Pages。仓库 Settings → Pages 的 Source 设为 **GitHub Actions**。

发布目录包含页面、联机组件、推理运行库和模型，不需要 Python 服务器或 API 密钥。资源使用相对路径，支持 `/guandanai/` 这样的项目网址。

## 目录

```text
src/game.html          游戏源文件
src/table-bot.js       电脑出牌与后台推理接入
src/layout.css         页面布局
src/ai/               策略输入编码与 Worker
ai/policy.onnx        浏览器使用的策略网络
ai/policy.ckpt        模型参数
ai/reference/         独立数值验证
scripts/              构建、预览、模型导出和打包
tests/                编码、推理及双浏览器联机检查
dist/                 构建后的网页
```

## 验证

玩家无需 Python；开发验证和模型导出可使用 Python、NumPy、ONNX 和 Playwright：

```powershell
python -m pip install numpy onnx playwright
npm test
python tests/check_encoding.py
python tests/browser_smoke.py
```

浏览器测试需要已安装 Chrome，并先启动本地预览。也可传入已发布网址，验证项目路径下的模型加载、开房、邀请链接、双端出牌同步、掉线接管和手机布局。

联机使用浏览器 WebRTC 和公共信令服务，连接情况会受双方网络影响。
