# IRONFALL 发行包 · 2.0.10

- 本地已打包：`IRONFALL-2.0.10-offline.zip`
- 文件大小：781487 字节
- SHA-256：`5BA379AE68C8CBA1CC09ACE7BFE739D29BBD9E06AE7551FF90F23362856AAF34`
- 发行包由维护者手动上传。本说明不代表已经创建 `v2.0.10` 标签或线上 Release。
- 二进制 ZIP 不再跟踪进 Git；push 代码不会自动上传发行附件。

## 使用

完整解压，不要在 ZIP 内直接运行，也不要使用旧目录的脚本。

- 单机：`开始游戏.cmd`，默认端口 18240。
- 联机：`开始联机.cmd`，默认端口 18200，保持服务器窗口开启，再在游戏大厅创建/加入房间。
- 首次没有 Node.js 时，先运行发行包中的 `开始游戏.cmd` 下载便携运行环境，再退出游戏并启动联机。开发仓库入口不负责下载环境。
- TCP 穿透目标：`127.0.0.1:18200`。队友填写穿透工具分配的域名和公网端口。
- 重复启动联机会替换同目录旧服务、断开旧房间，队友需重新加入。不会自动关闭其他目录或无关程序。
- EADDRINUSE 表示端口被占用；查看 `lan-error.log`。更多说明见根目录 README。

## 包内文件

`开始游戏.cmd`、`开始联机.cmd`、`IRONFALL.html`、`index.html`、`使用说明.txt`、`RELEASE_NOTES.md`、`LICENSE`，以及 `tools/launch-app.mjs`、`tools/serve-single.mjs`、`tools/lan-server.mjs`。

## 发布与校验

手动创建发行版，选择已核对的提交/标签，上传 ZIP 并复制包内 RELEASE_NOTES.md。不要把旧版链接当作最新版下载地址。

- Gitee 发行列表：https://gitee.com/tsingovo/ironfall/releases
- GitHub 发行列表：https://github.com/tsingovo/ironfall/releases

```powershell
Get-FileHash .\IRONFALL-2.0.10-offline.zip -Algorithm SHA256
```

## 重新构建

先准备 `dist/RELEASE_NOTES.md`，并确保 HUD 与启动器的 BUILD 版本一致，然后：

```powershell
node tools/build-standalone.mjs
node tools/build-release.mjs 2.0.10
```

重新构建后重新计算校验和；不要沿用其他 ZIP 的数值。真实校园网多人联机与长时间稳定性待实机验证。
