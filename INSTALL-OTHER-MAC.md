# 在另一台 Mac 安装

当前版本 0.3.8，适配官方 ZCode macOS **3.15.3**。Apple Silicon 和 Intel 共用一个安装器。

1. 从 [Releases](https://github.com/Feifive/zcode-qqmusic-plugin/releases/latest) 下载 `ZCode-Music-Installer-0.3.8-macOS.zip` 并解压。
2. 完全退出 ZCode（⌘Q）。
3. 双击 `ZCode Music Installer.app`，选择「安装 / 修复」。应用不在 `/Applications` 时按提示选择。
4. 安装完成后点击「打开 ZCode」，播放 QQ 音乐即可。点击输入框上方最右侧固定的 ♪ 打开歌词设置。

无需另外安装 Node.js、npm 或 Xcode Command Line Tools。安装器使用目标电脑已安装 ZCode 的运行时；媒体读取库已包含两种 CPU 架构。需要能够写入 ZCode 的安装目录，以及足够存放一份官方原包备份的空间。

安装器目前为临时签名，未使用 Apple Developer ID 公证。若 macOS 阻止运行，请自行核实本仓库来源，并按系统提示允许；无需关闭 Gatekeeper、SIP 或其他系统安全设置。

## 后续升级

歌词设置 →「检查更新」→「更新并重启」。升级只写入 `~/Library/Application Support/ZCode Music/versions/` 和版本指针，不修改 `ZCode.app`，也不重新签名。下载或签名校验失败时保留现有版本；已成功升级后可选择「回退并重启」。

没有打开 ZCode 时，也可以运行安装器的「检查并更新」，随后重新打开 ZCode。

ZCode **官方升级**可能覆盖加载器。重新运行适配新版本的安装器进行修复；未经适配的 ZCode 版本会被拒绝，不会用旧备份覆盖新版官方应用。

## 数据与卸载

固定目录：`~/Library/Application Support/ZCode Music/`

- `versions/<版本>/`：独立插件与签名清单。
- `active.json`：当前版本及上一版本。
- `settings.json`：歌词开关与配色偏好。
- `backups/<ZCode版本>-<原包哈希>/ZCode.app`：目标电脑的原包。
- `installation.json`：加载器安装记录。

卸载：退出 ZCode，打开安装器，点击「卸载」。恢复匹配的官方原包，设置和插件备份保留。若官方应用已经被升级或其它程序修改，安装器会拒绝覆盖，避免回退官方版本。

## 开发者命令

```sh
npm test
# 已存在 release/zcode-music-0.3.8.json 时，无需私钥即可打包安装器
npm run pack:installer
# 从当前源码生成新的签名发布包，需要原发布私钥
npm run release
# 本机安装 / 升级 / 卸载
npm run install:app
npm run update
npm run uninstall
```

普通用户使用图形安装器即可；开发者构建需要 Node.js 22+ 和 Xcode Command Line Tools。
