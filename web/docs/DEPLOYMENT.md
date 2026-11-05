# 从仓库到朋友的一张链接

主站：[stevensun1005.github.io/guandanai](https://stevensun1005.github.io/guandanai/)。网站由 GitHub Pages 托管，发布流程在 `.github/workflows/pages.yml`。

## 检查与发布触发

PR 会运行 Node 测试、格式检查、生产构建，以及 Chromium 中的实际出牌和恶意牌谱导入检查，但不会部署。向 `main` 推送相关改动或手动运行工作流时，通过相同检查后上传 `web/dist` 并部署到 Pages；检查失败时不会继续部署。

仅文档、实验检查点归档及工作流中明确忽略的报告维护文件变化，不触发主分支自动部署。完整触发范围以[工作流](../../.github/workflows/pages.yml)为准。需要主动重新部署时，可在 Actions 的 **Deploy GitHub Pages → Run workflow** 中选择 `main`。

仓库 Pages 使用 **GitHub Actions** 作为发布来源。部署是否完成，以该次 Actions 的 `deploy` 成功状态为准；本地构建成功不等于线上已经更新。

项目使用相对资源路径，可以部署在仓库子路径，无需改写应用里的根目录地址。

## 本机验证

```bash
npm ci
npm test
npm run format:check
npm run build
npm run dev
```

打开 `http://127.0.0.1:8765/`。预览服务器只监听本机，修改源文件后需要重新构建。Windows 也可在构建完成后双击根目录的「启动预览.cmd」。

## 部署包含什么

不修改源码时，可以从提供网页附件的 [GitHub Release](https://github.com/stevensun1005/guandanai/releases) 下载 `guandan-web.zip`，解压到静态 HTTP(S) 服务。发布包与 `main`、Pages 可能不同步，请先核对该 Release 的版本和说明；训练检查点附件不属于网页发布包。网页包包含完整页面和默认模型，无需先安装 Node.js 或 Python。请通过服务地址访问，直接双击 `index.html` 的文件地址不能正常加载 Worker 与模型。随包提供的 `SHA256SUMS.txt` 可校验下载文件。

- 页面、模块打包结果、样式与图片。
- 同源的浏览器推理运行库和模型。
- 同源的房间连接库。
- `.nojekyll`，让静态资源按原目录发布。

模型计算在负责电脑的浏览器里运行，网页不依赖 Python 推理服务。只加入朋友房间的浏览器不会预先下载模型。构建只复制 `web/src/ai/models.mjs` 注册的默认模型，`ai/local/models/experiments/` 研究检查点和训练用 Critic 不进入网页包。Python 的模型导出、训练和批量评估工具属于开发流程。

## 更新与缓存

页面脚本、样式和 Worker 带有应用内容版本；模型使用自身内容版本。这样既避免新页面配上旧脚本，也让没有变化的权重继续使用浏览器缓存。

联机前，大家应刷新到相同页面版本；已入座页面版本不同会阻止开局。已经打开的牌局不会被强制刷新，建议打一局后再更新。

## 座位恢复

朋友可以在原标签页刷新或重新连接，按房主当前状态恢复座位。凭据保存在标签页存储中；主动退出、切换模式或进入练习后会清除。恢复消息要求页面版本一致，详见 [房间指南](./ROOMS.md)。房主自身刷新后的整桌恢复暂未实现。

## 联机的运行边界

房主浏览器推进游戏，公共信令帮助浏览器建立 WebRTC 连接。静态页面无法保证每一种 NAT、防火墙和后台休眠环境都能连通。房主需要保持页面打开；关闭后，其他人可以选择在各自本机和电脑继续，当前版本不会自动产生新的联机房主。

如果发布后出现资源错误，检查 Actions 部署状态、资源相对路径和四个客户端的版本是否一致。反馈具体操作、设备、浏览器与页面版本，方便定位。
