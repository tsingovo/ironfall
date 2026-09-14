# IRONFALL 发布包

- 当前版本：**2.0.7**
- 对应标签：`v2.0.7`
- Windows 离线包：`IRONFALL-2.0.7-offline.zip`（349.6 KB）
- SHA-256：`ECD8F3ADFEEF2D30E027EB37389DD5C7202879CF95645852EC139CAB7007B99D`

## 怎么给玩家

完整解压 ZIP 后双击 `开始游戏.cmd`。

- **不要**在压缩包内直接运行（`tools/` 路径读不到）
- **不要**继续使用旧版本目录里的启动脚本
- 解压出来是这 5 项：`开始游戏.cmd`、`IRONFALL.html`、`使用说明.txt`、`LICENSE`、`tools/`

启动器会自动备好运行环境（系统没有 Node.js 时下载便携版），
然后用 Chrome/Edge 的**独立 App 窗口**打开 —— 无标签栏，`Ctrl+W` 不会误关游戏。

## 下载地址

| 平台 | 链接 |
|---|---|
| Gitee（推荐，公开可访问） | https://gitee.com/tsingovo/ironfall/releases/download/v2.0.7/IRONFALL-2.0.7-offline.zip |
| GitHub | https://github.com/tsingovo/ironfall/releases/tag/v2.0.7 |

> GitHub 账号目前被其滥用检测系统标记、正在人工复核，未登录访客访问会得到 404。
> 复核结束前请使用 Gitee 链接。

## 校验下载是否完整

```powershell
# Windows PowerShell
Get-FileHash .\IRONFALL-2.0.7-offline.zip -Algorithm SHA256
```

```bash
# macOS / Linux
shasum -a 256 IRONFALL-2.0.7-offline.zip
```

结果应当等于上面记录的 SHA-256。

> 更正说明：本文件此前记录的 `C0353BC0…` 实际是 **2.0.4** 的校验和
>（2.0.7 的 README 误用了旧版本的值），已在此更正。
> 下表由各 zip 实际计算得出，可直接用于校验。

## 各版本校验和

| 版本 | 大小 | SHA-256 |
|---|---|---|
| 2.0.2 | 348.4 KB | `D273E16A37B9625D7851FA7AD7C82D5838FDCC28A1CAFAFFD9DAE7AB0BAEBA02` |
| 2.0.3 | 349.0 KB | `E07724BE33CD0F7CB4852C3359E3BA5379677BC32C6E6CE2280D199695B473F6` |
| 2.0.4 | 348.6 KB | `C0353BC0C9E8431DD51D4C9F3FBD0C6E1AF7F4E12ABF3880001BD8477C45A574` |
| 2.0.5 | 348.5 KB | `6655AE6E85CE883F969EAB7475C4A7F258948D23BA3019E1214BE995E540E237` |
| 2.0.6 | 348.4 KB | `447B9791E9C85A646E5F34EEDDB3AD157D452BEB1DA269C8C802032066D2C5A1` |
| **2.0.7** | **349.6 KB** | **`ECD8F3ADFEEF2D30E027EB37389DD5C7202879CF95645852EC139CAB7007B99D`** |

已验证：`release/IRONFALL-2.0.7-offline/IRONFALL.html` 与 zip 内的同名文件
SHA-256 完全一致，说明 zip 与解压目录同源、不存在版本错配。

## 怎么重新构建

```bash
node tools/build-standalone.mjs        # → dist/IRONFALL.html（单文件离线版）
node tools/build-release.mjs 2.0.7     # → dist/IRONFALL-2.0.7-offline.zip
```

打包器是零依赖自研实现（含手写 ZIP 写入器），不引入任何第三方库。
