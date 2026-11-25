'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./lib/db');
const { YtDlp } = require('./lib/ytdlp');
const { FFmpeg } = require('./lib/ffmpeg');
const { setDataDir: CharsetSetDataDir, info: charsetInfo } = require('./lib/charset');
const { checkBinaries, installYtDlp, installFFmpeg, resolveBinary } = require('./lib/binManager');
const { extractPlaylist, downloadVideo, detectDuplicates } = require('./lib/downloadService');
const { convertVideo } = require('./lib/convertService');
const { preview, execute, revert, resolveRules, previewLocal, executeLocal } = require('./lib/renameService');
const { removeFile, removeDir, countFiles } = require('./lib/fileCleaner');
const { removePlaylist, removeVideos } = require('./lib/deleteService');
const { ensureAudioTrack, cleanDownloadLeftovers } = require('./lib/mediaFix');
const { migrateDataDir } = require('./lib/dataDir');
const { RenameEngine } = require('./lib/renameEngine');

let win = null;
let store = null;
let settings = null;
let ytDlp = null;
let ffmpeg = null;

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DATA_DIR = () => path.join(app.getPath('userData'));
const STORAGE_DIR = () => settings.storage_dir && settings.storage_dir.trim() !== ''
  ? settings.storage_dir
  : path.join(app.getPath('userData'), 'media');

// ---------------------------------------------------------------------------
// 统一数据目录
//
// 开发模式（electron .）的 userData 目录名取自 package.json 的 name，
// 打包后取自 productName —— 两者不同会导致「切换开发版/安装版后历史记录消失」。
// 这里显式固定目录名，使两种运行方式共用同一份数据。
// ---------------------------------------------------------------------------
const DATA_DIR_NAME = 'mediahub-desktop';
const LEGACY_DIR_NAMES = ['MediaHub'];

function unifyUserDataDir() {
  try {
    const base = app.getPath('appData');
    app.setPath('userData', path.join(base, DATA_DIR_NAME));
  } catch (e) { /* 保持默认 */ }
}

/** 目标目录没有数据、但旧目录有时，把旧数据迁移过来 */
function migrateLegacyData() {
  try {
    return migrateDataDir(DATA_DIR(), app.getPath('appData'), LEGACY_DIR_NAMES);
  } catch (e) { /* 迁移失败不阻断启动 */ }
  return { migrated: false, from: '' };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE())) {
      settings = Object.assign({ storage_dir: '', yt_dlp: '', ffmpeg: '', ffprobe: '', theme: 'light', proxy: '', max_concurrent_downloads: 3, concurrent_fragments: 4, auto_convert_format: 'mp3' }, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')));
      return;
    }
  } catch (e) {}
  settings = { storage_dir: '', yt_dlp: '', ffmpeg: '', ffprobe: '', theme: 'light', proxy: '', max_concurrent_downloads: 3, concurrent_fragments: 4, auto_convert_format: 'mp3' };
}

function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  refreshBinaries();
  return settings;
}

function refreshBinaries() {
  const ytPath = resolveBinary('yt_dlp', settings) || resolveBinary('yt-dlp', settings) || 'yt-dlp';
  const ffPath = resolveBinary('ffmpeg', settings) || 'ffmpeg';
  const fpPath = resolveBinary('ffprobe', settings) || 'ffprobe';
  ytDlp = new YtDlp(ytPath);
  ffmpeg = new FFmpeg(ffPath, fpPath);
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('event', { channel, payload });
}

/** 并发池：最多 limit 路同时执行 worker(items[i])，单个失败不影响整体 */
const { runPool } = require('./lib/pool');

/** 正在进行的下载任务 → 暂停/继续控制句柄 */
const downloadControls = new Map();

/** 暂停 / 继续某个下载任务 */
function setPaused(videoId, paused) {
  const c = downloadControls.get(videoId);
  if (!c) return { ok: false, error: '任务不存在或已结束' };
  const fn = paused ? c.pause : c.resume;
  if (typeof fn !== 'function') return { ok: false, error: '该任务不支持暂停（可能尚未启动）' };
  const done = fn();
  if (!done) return { ok: false, error: (paused ? '暂停' : '继续') + '失败' };
  emit('download:paused', { videoId, paused: !!paused });
  return { ok: true, paused: !!paused };
}

/**
 * 下载单个视频。
 * 若所属播放列表开启了「下载即转换」，下载完成后自动转成音频。
 */
async function downloadOne(videoId, force) {
  const row = store.getVideo(videoId);
  const playlist = row ? store.getPlaylist(row.playlist_id) : null;
  emit('download:task:start', {
    videoId,
    title: row ? (row.title || row.current_name || '') : '',
    playlistId: row ? row.playlist_id : null,
  });

  // 暂停/继续控制句柄：与任务一一对应，供 IPC 调用
  const control = { paused: false, pause: null, resume: null, stop: null, pid: null };
  downloadControls.set(videoId, control);

  let r;
  try {
    r = await downloadVideo(store, ytDlp, videoId, STORAGE_DIR(), emit, {
      force: !!force,
      proxy: settings.proxy || '',
      concurrent_fragments: parseInt(settings.concurrent_fragments || 4, 10),
      ffmpeg_path: settings.ffmpeg || '',
      control,
    });
  } finally {
    downloadControls.delete(videoId);
  }

  // 下载产物完整性检查：若音视频未分离（缺 ffmpeg 导致），自动合并修复
  let fixNote = '';
  if (r.ok && r.file) {
    try {
      const dir = path.dirname(r.file);
      cleanDownloadLeftovers(dir);
      const fixed = await ensureAudioTrack(ffmpeg, r.file);
      if (fixed.changed && fixed.file) {
        const base = path.basename(fixed.file);
        store.updateVideo(videoId, {
          filepath: fixed.file,
          current_name: base,
          ext: path.extname(base).replace('.', '').toLowerCase(),
        });
        r.file = fixed.file;
        fixNote = '（已自动合并分离的音视频）';
      } else if (!fixed.ok) {
        fixNote = '（' + fixed.reason + '）';
      }
    } catch (e) {
      fixNote = '（完整性检查异常：' + (e && e.message ? e.message : e) + '）';
    }
  }

  let converted = false;
  let convertError = '';
  if (r.ok && playlist && playlist.auto_convert) {
    const fmt = settings.auto_convert_format || 'mp3';
    emit('convert:progress', { videoId, percent: 0, stage: 'auto' });
    const c = await convertVideo(store, ffmpeg, videoId, { format: fmt }, STORAGE_DIR(), emit);
    converted = !!c.ok;
    if (!c.ok) convertError = c.error || '';
  }

  emit('download:task:done', {
    videoId,
    ok: !!r.ok,
    error: r.error || convertError || '',
    converted,
    note: fixNote,
  });
  return Object.assign({}, r, { converted, convertError, fixNote });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 调试工具默认关闭；仅排障时显式设置环境变量 VIDO_DEVTOOLS=1 才打开
  if (process.env.VIDO_DEVTOOLS === '1') win.webContents.openDevTools();
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_, patch) => saveSettings(patch));
  ipcMain.handle('storage:dir', () => STORAGE_DIR());

  ipcMain.handle('binaries:check', async () => {
    const bins = checkBinaries(settings);
    const out = { ytDlp: !!bins.ytDlp, ffmpeg: !!bins.ffmpeg, ffprobe: !!bins.ffprobe, paths: bins };
    try { out.ytDlpVersion = bins.ytDlp ? await ytDlp.version() : ''; } catch (e) {}
    try { out.ffmpegVersion = bins.ffmpeg ? await ffmpeg.version() : ''; } catch (e) {}
    return out;
  });

  ipcMain.handle('binaries:install', async (_, name) => {
    const dir = path.join(DATA_DIR(), 'bin');
    const proxy = settings.proxy || '';
    try {
      if (name === 'yt-dlp') {
        const p = await installYtDlp(dir, (pct) => emit('install:progress', { name, percent: pct }), proxy);
        settings.yt_dlp = p;
        saveSettings({ yt_dlp: p });
        emit('install:done', { name, path: p });
        return { ok: true, path: p };
      }
      if (name === 'ffmpeg' || name === 'ffprobe') {
        // ffmpeg 与 ffprobe 在同一个发行包内，一并安装；ffprobe 失败不影响 ffmpeg
        const r = await installFFmpeg(dir, (pct) => emit('install:progress', { name, percent: pct }), proxy);
        const ff = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        const fp = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        const patch = {};
        if (r.installed.includes('ffmpeg')) patch.ffmpeg = ff;
        if (r.installed.includes('ffprobe')) patch.ffprobe = fp;
        if (Object.keys(patch).length) saveSettings(patch);
        emit('install:done', { name, path: ff });
        if (r.failed.length) {
          return { ok: true, path: ff, warning: '部分组件未安装：\n' + r.failed.join('\n') };
        }
        return { ok: true, path: ff };
      }
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
    return { ok: false, error: '未知组件: ' + name };
  });

  ipcMain.handle('playlists:list', () => store.listPlaylists());
  ipcMain.handle('playlist:get', (_, id) => store.getPlaylist(id));
  ipcMain.handle('playlist:create', async (_, { url, cookies }) => {
    return await extractPlaylist(store, ytDlp, url, cookies || '', emit, { proxy: settings.proxy || '' });
  });
  ipcMain.handle('playlist:setAutoConvert', (_, { playlistId, autoConvert }) => {
    return store.updatePlaylist(playlistId, { auto_convert: !!autoConvert });
  });

  ipcMain.handle('videos:list', (_, playlistId) => store.listVideos(playlistId));
  ipcMain.handle('video:get', (_, id) => store.getVideo(id));

  // ---------------- 删除（记录 / 文件） ----------------
  ipcMain.handle('playlist:remove', async (_, { playlistId, deleteFiles }) => {
    return removePlaylist(store, STORAGE_DIR(), playlistId, !!deleteFiles);
  });

  ipcMain.handle('video:remove', async (_, { videoIds, deleteFiles }) => {
    return removeVideos(store, STORAGE_DIR(), videoIds, !!deleteFiles);
  });

  ipcMain.handle('download:video', async (_, args) => {
    const a = args || {};
    const videoId = (a.videoId !== undefined) ? a.videoId : a;
    return await downloadOne(videoId, !!a.force);
  });
  ipcMain.handle('download:playlist', async (_, args) => {
    const a = args || {};
    const playlistId = (a.playlistId !== undefined) ? a.playlistId : a;
    const all = store.listVideos(playlistId);
    // 默认只下未完成项；includeDone=true 时包含已下载项（触发重复下载提示）
    const videos = a.includeDone ? all : all.filter((v) => v.status === 'pending' || v.status === 'failed');
    if (videos.length === 0) return { ok: true, okCount: 0, failCount: 0, message: '没有需要下载的条目' };

    // skipDuplicates=true（"继续下载"）：只下未完成项，跳过重复检测，不弹确认
    if (!a.force && !a.skipDuplicates) {
      const dups = detectDuplicates(store, videos, STORAGE_DIR());
      if (dups.length > 0) {
        return {
          ok: false,
          needConfirm: true,
          error: '检测到 ' + dups.length + ' 个条目此前已下载，是否重新下载？',
          duplicates: dups,
        };
      }
    }

    const concurrency = Math.max(1, Math.min(8, parseInt(settings.max_concurrent_downloads || 3, 10)));
    emit('download:batch:start', { playlistId, total: videos.length, concurrency });

    // 并发下载：多路 yt-dlp 同时跑，吃满带宽与 CPU
    let okCount = 0, failCount = 0, converted = 0;
    await runPool(videos, concurrency, async (v) => {
      const r = await downloadOne(v.id, !!a.force);
      if (r.ok) {
        okCount++;
        if (r.converted) converted++;
      } else {
        failCount++;
      }
    });

    emit('download:playlist:done', { playlistId, okCount, failCount, converted });
    return { ok: true, okCount, failCount, converted, concurrency };
  });

  // ---------------- 暂停 / 继续 ----------------
  ipcMain.handle('download:pause', (_, videoId) => setPaused(videoId, true));
  ipcMain.handle('download:resume', (_, videoId) => setPaused(videoId, false));
  ipcMain.handle('download:pauseAll', () => {
    let n = 0;
    for (const id of Array.from(downloadControls.keys())) {
      if (setPaused(id, true).ok) n++;
    }
    return { ok: true, count: n };
  });
  ipcMain.handle('download:resumeAll', () => {
    let n = 0;
    for (const id of Array.from(downloadControls.keys())) {
      if (setPaused(id, false).ok) n++;
    }
    return { ok: true, count: n };
  });

  // ---------------- 下载记录 ----------------
  ipcMain.handle('downloads:list', () => store.listDownloads());
  ipcMain.handle('downloads:remove', (_, id) => store.deleteDownload(id));
  ipcMain.handle('downloads:clear', () => store.clearDownloads());

  ipcMain.handle('app:version', () => ({ name: app.getName(), version: app.getVersion() }));

  ipcMain.handle('rename:preview', (_, args) => preview(store, args.videoIds, args.ruleIds, args.useCurrentName));
  ipcMain.handle('rename:execute', async (_, args) => {
    const r = await execute(store, args.videoIds, args.ruleIds, args.useCurrentName);
    // 改名含下载记录路径同步，立即落盘，避免防抖窗口内退出丢失
    if (typeof store.flush === 'function') store.flush();
    return r;
  });
  ipcMain.handle('rename:rules', () => ({ schema: RenameEngine.schema(), rules: store.listRules(false) }));
  ipcMain.handle('rename:rule:save', (_, rule) => store.saveRule(rule));
  ipcMain.handle('rename:rule:delete', (_, id) => store.deleteRule(id));
  ipcMain.handle('rename:history', (_, videoId) => store.listHistory(videoId));
  ipcMain.handle('rename:revert', (_, historyId) => revert(store, historyId));

  ipcMain.handle('convert:video', async (_, { videoId, opts }) => {
    return await convertVideo(store, ffmpeg, videoId, opts || {}, STORAGE_DIR(), emit);
  });

  ipcMain.handle('charset:info', () => charsetInfo());

  ipcMain.handle('open:folder', (_, p) => { try { shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('show:item', (_, p) => { try { shell.showItemInFolder(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

  // ---------------- 原生对话框 ----------------
  ipcMain.handle('dialog:selectFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
    return (r.canceled || !r.filePaths || r.filePaths.length === 0) ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:selectFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择文件（可多选）', properties: ['openFile', 'multiSelections'] });
    return (r.canceled || !r.filePaths) ? [] : r.filePaths;
  });
  ipcMain.handle('fs:list', (_, { dir }) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
      return { files };
    } catch (e) {
      return { files: [], error: e.message };
    }
  });

  // ---------------- 本地文件改名（不依赖数据库） ----------------
  ipcMain.handle('rename:localPreview', (_, { paths, ruleIds }) => {
    const rules = resolveRules(store, ruleIds);
    return previewLocal(paths, rules);
  });
  ipcMain.handle('rename:localExecute', (_, { paths, ruleIds }) => {
    const rules = resolveRules(store, ruleIds);
    return executeLocal(paths, rules);
  });
}

// ---------------- lifecycle ----------------
// 必须在 app ready 之前固定 userData 目录，否则开发版与安装版会各用各的目录
unifyUserDataDir();

/**
 * 启动回收：把上次异常退出（暂停后关闭、强退、崩溃）时卡在
 * downloading / converting 的任务恢复正常。
 *  - 产物已在磁盘且非空 → 视为已完成，标记 downloaded（计入"已下载"，避免重复下载）
 *  - 产物不存在或为空   → 重置为 pending（允许重新下载）
 * 这样重启后"已下载 X"计数准确，也不会出现卡死任务永远不下载的情况。
 */
/**
 * 判断一个文件路径是否是 yt-dlp 的分离流中间产物（而非合并后的完整文件）。
 * 分离流命名形如：标题 [ID].f399.mp4 / 标题 [ID].f251.webm
 * 这类文件：① 通常无音轨（纯视频流）或纯音频；② 旧版并发错位时会被误记为 downloaded。
 * 正常合并产物是：标题 [ID].mp4 / .mkv / .webm，不带 .f<数字>. 段。
 */
function isFragmentPath(filepath) {
  if (!filepath || typeof filepath !== 'string') return false;
  const base = require('path').basename(filepath);
  return /\.f\d+\.(mp4|webm|m4a|opus|mkv|mov|avi)$/i.test(base);
}

function recoverInterruptedTasks() {
  let completed = 0, reset = 0, fragments = 0;
  try {
    const fsMod = require('fs');
    for (const v of store.data.videos) {
      // ① 卡在下载中/转换中的任务：按产物是否存在恢复
      if (v.status === 'downloading' || v.status === 'converting') {
        const f = v.filepath;
        let usable = false;
        if (f && fsMod.existsSync(f)) {
          try { usable = fsMod.statSync(f).size > 0; } catch (e) { usable = false; }
        }
        if (usable) {
          v.status = 'downloaded';
          delete v.error_message;
          completed++;
        } else {
          v.status = 'pending';
          delete v.error_message;
          reset++;
        }
        continue;
      }

      // ② 伪完成记录：标着 downloaded/converted，但产物是分离流碎片（旧版并发错位的残留）。
      //    这类记录会误导「继续下载」跳过、转音频时报无音轨，必须重置为 pending 补下。
      //    注：普通"文件丢失"不在此处理——converted 记录的源视频被清理属正常（音频产物在 audio_path）。
      if (v.status === 'downloaded' || v.status === 'converted') {
        if (isFragmentPath(v.filepath)) {
          v.status = 'pending';
          delete v.filepath;
          delete v.original_name;
          delete v.current_name;
          delete v.audio_path;
          delete v.error_message;
          fragments++;
        }
      }
    }
    if (completed || reset || fragments) store.flush();
    if (completed || reset || fragments) {
      console.log(`[Vido] 启动回收：${completed} 个恢复已完成，${reset} 个重置待下载，${fragments} 个伪完成/丢失记录重置待下载`);
    }

    // ③ 存量失效下载记录自动修复：
    //    历史改名/并发错位后，部分下载记录 filepath 指向旧文件名或分离流碎片（已不存在）。
    //    - 若关联视频记录有有效新路径 → 同步过来（改名场景）；
    //    - 否则（视频未真正下载 / 指向脏碎片）→ 打 file_missing 标记，避免界面误导。
    let fixed = 0, marked = 0;
    const videoById = new Map(store.data.videos.map((v) => [v.id, v]));
    for (const d of store.data.downloads) {
      if (d.filepath && fsMod.existsSync(d.filepath)) continue; // 路径有效，跳过
      const v = d.video_id !== undefined ? videoById.get(d.video_id) : null;
      if (v && v.filepath && fsMod.existsSync(v.filepath)) {
        d.filepath = v.filepath;
        d.filename = require('path').basename(v.filepath);
        d.file_missing = false;
        fixed++;
      } else if (!d.file_missing) {
        d.file_missing = true; // 记录保留为历史，但标记文件已失效
        marked++;
      }
    }
    if (fixed || marked) {
      store.flush();
      console.log(`[Vido] 启动修复：${fixed} 条下载记录同步新路径，${marked} 条标记为文件已失效`);
    }
  } catch (e) { /* 回收失败不阻断启动 */ }
  return { completed, reset, fragments };
}

function bootstrap() {
  const mig = migrateLegacyData();
  loadSettings();
  fs.mkdirSync(STORAGE_DIR(), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR(), 'bin'), { recursive: true });
  store = new Store(DATA_DIR());
  if (mig.migrated) {
    console.log('[Vido] 已从旧数据目录迁移：' + mig.from);
  }
  recoverInterruptedTasks();
  refreshBinaries();
  CharsetSetDataDir(
    app.isPackaged
      ? path.join(process.resourcesPath, 'charset-data')
      : path.join(__dirname, '..', 'charset-data')
  );
}

// 单实例锁：多次 npm start 只聚焦已有窗口，避免叠多个旧窗口造成“修好了却还看到旧现象”的混淆
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.reload(); // 强制重新加载最新 index.html，避免看到旧的（未修复）内容
  }
});

app.whenReady().then(() => {
  bootstrap();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// 退出前：先解冻并终止所有被暂停的下载进程组，再立即落盘，
// 避免 SIGSTOP 冻结的 yt-dlp/ffmpeg 变成孤儿进程，也避免防抖窗口内的状态丢失
app.on('before-quit', () => {
  for (const c of downloadControls.values()) {
    try {
      if (c.paused && typeof c.resume === 'function') c.resume(); // SIGCONT 解冻
      if (typeof c.stop === 'function') c.stop();                 // 终止进程组
    } catch (e) { /* ignore */ }
  }
  if (store) store.flush();
});
