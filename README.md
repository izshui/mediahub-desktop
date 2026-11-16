# MediaHub 桌面版

> **慧天科技出品** ｜ 当前版本：v1.4.0 ｜ 更新日期：2026-11-16 ｜ 完整变更见 [CHANGELOG.md](CHANGELOG.md)

本地运行的媒体工具箱，**Mac / Windows 安装即用，无需服务器、不上传任何文件**。

## 这是什么

一个装在自己电脑上的媒体处理工具：把 YouTube / Facebook / Twitter 播放列表批量下载到本地，用 13 种规则批量改名，再转成音频格式。

**所有媒体文件只保存在你本机**；程序仅记录文件路径用于管理，绝不会上传到任何服务器。

## 功能清单

| 模块 | 说明 |
|---|---|
| 📥 **批量下载** | 粘贴 YouTube / Facebook / Twitter 播放列表或单视频链接，解析后逐条下载；支持 cookies、实时进度与速度显示 |
| ⚡ **并发下载** | 批量下载并发池执行（默认 3 路，可调 1～8）；yt-dlp 分片并发（`--concurrent-fragments`），吃满带宽与 CPU |
| 📊 **进度条** | 每个任务一条独立进度条（百分比 / 实时速度 / ETA），顶部显示总体进度与并发路数 |
| 🔁 **下载即转换** | 解析后询问是否「下载时同步转音频」，按播放列表记住选择，下载完成自动转码 |
| 🧾 **下载记录** | 永久保留每次下载的时间/标题/平台/文件名/大小，可定位文件、删除记录、清空列表；重复下载追加记录而非覆盖 |
| 🗑️ **删除管理** | 播放列表与媒体库均支持删除（单个 / 批量）；可选择「仅删记录」或「连同磁盘文件一起删」，两段式确认并列出待删清单 |
| ⚠️ **重复下载提示** | 下载前自动检测「已下载过 / 同名文件已存在」，命中即弹确认框并列出具体条目，确认后才继续 |
| ✏️ **批量改名** | 13 种改名规则管线（模板 / 字段限制 / 简繁转换 / 批量删除 / 增加 / 查找替换 / 大小写 / 去首尾 / 非法字符清理 / 智能生成 / slug / 音译），支持预览、执行与回滚 |
| 🧠 **智能命名** | 自动剥离视频 ID、平台后缀、标签段，识别频道与核心标题，重组为 `频道 - 核心标题`；可选去表情符号 |
| 🔤 **简繁转换** | 三层回退：opencc 二进制 → Python opencc → 内置 JSON 映射，完全离线可用 |
| 🎵 **视频转音频** | mp3 / m4a / aac / flac / opus / wav / ogg，可选码率与音量标准化；音视频未分离时自动合并补救 |
| 🚀 **GPU / 多核加速** | 转码自动探测硬件解码器，macOS 启用 **VideoToolbox**（GPU 解码），并用满全部 CPU 核心 |
| 📚 **媒体库** | 按播放列表筛选，查看状态、文件名与大小，可打开或定位本机文件 |
| ⚙️ **依赖自愈** | 缺失 yt-dlp / ffmpeg / ffprobe 时一键自动下载（代理 + 多镜像容错 + 文件类型校验） |

## 版本历史

| 版本 | 日期 | 概要 |
|---|---|---|
| **v1.4.0** | 2026-11-16 | 修复音视频未合并导致的转音频失败（含自动合并补救）；智能生成改名改为清洗+重组 |
| v1.3.0 | 2026-11-16 | 播放列表与媒体库支持删除（含批量）；文件删除强制限定在存储目录内 |
| v1.2.0 | 2026-11-10 | 并发下载、进度条、下载即转换、VideoToolbox GPU 加速；出品方改为慧天科技 |
| v1.1.0 | 2026-11-10 | 新增下载记录与重复下载提示；修复二进制依赖下载失败、cookies 未生效、前端脚本被拦截等问题 |
| v1.0.0 | 2026-11-05 | 首个可用版本：下载 / 改名 / 转音频 / 媒体库 / 自动安装依赖 |

---

## 一、架构说明

```
mediahub-desktop/
├── main/                 # Electron 主进程（Node）
│   ├── main.js           # 窗口 + IPC 路由 + 生命周期
│   ├── preload.js        # contextBridge 安全暴露 api
│   └── lib/              # 核心逻辑（与 PHP 版逐一对应移植）
│       ├── mb.js / sanitizer.js / nameParser.js / charset.js
│       ├── renameEngine.js   # 13 种改名规则 + ExtChange
│       ├── cmd.js / ytdlp.js / ffmpeg.js / binManager.js
│       ├── db.js            # 轻量 JSON 存储（替代 MySQL，零原生依赖）
│       ├── renameService.js / downloadService.js / convertService.js
├── renderer/             # 前端界面（原生 HTML/CSS/JS，无框架）
│   ├── index.html / style.css
├── charset-data/         # 简繁转换映射表（s2t.json / t2s.json）
├── tools/                # 构建脚本（make-icon.js / build-mac.sh）
├── build/                # 图标资源（icon.icns）
├── package.json          # 依赖与打包配置（electron-builder）
├── CHANGELOG.md          # 版本更新日志
```

- **存储**：用 JSON 文件（`userData/data.json`）代替 MySQL，安装即用、零数据库配置。集合包含 `playlists / videos / rules / history / downloads`（下载记录）。
- **并发**：批量下载走并发池（默认 3 路，`settings.max_concurrent_downloads` 可调 1～8）；单视频走 yt-dlp `--concurrent-fragments` 分片并发（`settings.concurrent_fragments`）。
- **硬件加速**：转码时探测 `ffmpeg -hwaccels`，macOS 上若支持则自动加 `-hwaccel videotoolbox` 调用 GPU 解码，并统一 `-threads 0` 用满 CPU 核心。
- **二进制依赖**：yt-dlp / ffmpeg / ffprobe 不在安装包内（体积大、需联网获取）。首次使用时在「设置」页点击**自动下载**即可；也可在系统安装后由程序自动从 `PATH` 发现。
- **简繁转换**：内置 JSON 映射表，完全离线可用；若系统装有 `opencc` 或 Python `opencc` 模块则自动优先使用。

---

## 二、开发运行（需 Node ≥ 18）

```bash
cd mediahub-desktop
npm install          # 安装 electron / electron-builder
npm start           # 启动开发模式窗口
```

---

## 三、打包成安装包

```bash
# Mac：生成 .dmg + .zip（Intel x64）
npm run dist:mac

# Windows：生成 .exe 安装包（NSIS，可自选安装目录）
npm run dist:win
```

产物在 `dist/` 目录：

- macOS：`MediaHub-1.4.0-mac-x64.dmg`（111MB，可拖拽安装）/ `MediaHub-1.4.0-mac-x64.zip`（99MB）
- Windows：`MediaHub Setup 1.4.0.exe`

### macOS 打包说明（`tools/build-mac.sh`）

脚本做了四件事，**全程离线**，不会重新下载 Electron 运行时：

1. `electron-builder --mac --x64 --dir --config.electronDist=node_modules/electron/dist`
   —— 通过 `electronDist` 复用本地已装好的 Electron（`node_modules/electron/dist`），避免联网重下 ~100MB；
2. `codesign --force --deep --sign -` 做 **ad-hoc 签名**（无 Apple 开发者证书时的本机可运行签名）；
3. `ditto` 打包 zip；
4. `hdiutil` 制作 dmg（内含 `/Applications` 拖拽安装快捷方式）。

> **图标**：仓库已内置自绘图标 `build/icon.icns`（蓝紫渐变圆角 + 白色播放三角）。
> 想改样式：编辑 `tools/make-icon.js` 后执行 `npm run icon`，再重新打包。
> Windows 图标 `build/icon.ico` 缺省时用 electron-builder 默认图标，不影响打包。

### 分发给他人时

未做 Apple 公证（notarization），对方首次打开需先去掉隔离属性：

```bash
xattr -rd com.apple.quarantine /Applications/MediaHub.app
```

### 已知环境坑

- **不要在设置了 `ELECTRON_RUN_AS_NODE=1` 的环境里运行**（部分 IDE / 沙箱会注入此变量）。它会让 Electron 退化成纯 Node，导致 `require('electron')` 拿不到 `app` 而启动失败。脚本已自动 `unset`。
- 某些受限沙箱会把 `.asar` 当作"包"而拒绝复制，导致 electron-builder 拷贝 Electron 运行时失败。脚本已通过清空 `NODE_OPTIONS` 并优先使用系统真实二进制规避。

---

## 四、首次使用流程

1. 打开 MediaHub → 「设置」页，确认 yt-dlp / ffmpeg / ffprobe 状态；缺失则点「自动下载」（国内网络请先在「网络代理」填入代理地址；npmmirror 源可直连）。
2. 「下载与转码性能」按需调整**同时下载数**（默认 3，建议 3～5）与**分片并发数**（默认 4）。
3. 「下载」页粘贴播放列表链接 → 「解析」→ 此时会询问**是否在下载时同步转换为音频**（确定 = 下载并转换，取消 = 仅下载）。
4. 选中播放列表「下载全部」（同一链接重复解析会复用原记录，不会重复建单）；若提示「检测到 N 个条目此前已下载」，确认后即重新下载。
5. 「正在下载」面板可看到每个任务的进度条、速度与 ETA，顶部是总体进度。
6. 「下载记录」页查看历史下载，可定位文件或清空记录（清空只清列表，不删文件）。
7. 「媒体库」查看已下载文件，可「打开 / 位置」定位本机文件。
8. 「改名」页勾选文件、配置规则 →「预览」核对 →「执行改名」（可随时在预览里回滚）。
9. 「转音频」页可单独把已下载视频转成音频（下载时未开启自动转换的，在这里手动处理）。

---

## 五、目录与数据

- 媒体文件默认存于：`userData/media/`（可在「设置 → 存储位置」用「选择文件夹」按钮指定）。
- 元数据、改名规则、改名历史、**下载记录**存于：`userData/data.json`。
- 自动下载的二进制存于：`userData/bin/`。
- 全部数据仅在本机，不联网同步、不上传服务器。

---

## 六、与线上 PHP 版的关系

本项目是从线上 PHP+MySQL 方案**重构而来的纯本地版本**：去掉了虚拟主机 / 数据库 / Worker 分布式架构，把改名引擎、简繁转换、yt-dlp/ffmpeg 封装等核心逻辑逐行移植为 Node 实现，并用 JSON 存储替代 MySQL，真正做到"安装即用、文件留本地"。线上版仍保留在 `../mediahub`。
