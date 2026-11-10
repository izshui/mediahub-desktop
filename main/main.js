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

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE())) {
      settings = Object.assign({ storage_dir: '', yt_dlp: '', ffmpeg: '', ffprobe: '', theme: 'light' }, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')));
      return;
    }
  } catch (e) {}
  settings = { storage_dir: '', yt_dlp: '', ffmpeg: '', ffprobe: '', theme: 'light', proxy: '' };
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
  // 开发时可打开 DevTools（调试完成后可注释掉）
  win.webContents.openDevTools();
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
    return await extractPlaylist(store, ytDlp, url, cookies || '', emit);
  });

  ipcMain.handle('videos:list', (_, playlistId) => store.listVideos(playlistId));
  ipcMain.handle('video:get', (_, id) => store.getVideo(id));

  ipcMain.handle('download:video', async (_, args) => {
    const a = args || {};
    const videoId = (a.videoId !== undefined) ? a.videoId : a;
    return await downloadVideo(store, ytDlp, videoId, STORAGE_DIR(), emit, { force: !!a.force });
  });
  ipcMain.handle('download:playlist', async (_, args) => {
    const a = args || {};
    const playlistId = (a.playlistId !== undefined) ? a.playlistId : a;
    const all = store.listVideos(playlistId);
    // 默认只下未完成项；includeDone=true 时包含已下载项（触发重复下载提示）
    const videos = a.includeDone ? all : all.filter((v) => v.status === 'pending' || v.status === 'failed');
    if (videos.length === 0) return { ok: true, okCount: 0, failCount: 0, message: '没有需要下载的条目' };

    if (!a.force) {
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

    let okCount = 0, failCount = 0;
    for (const v of videos) {
      const r = await downloadVideo(store, ytDlp, v.id, STORAGE_DIR(), emit, { force: !!a.force });
      if (r.ok) okCount++; else failCount++;
    }
    emit('download:playlist:done', { playlistId, okCount, failCount });
    return { ok: true, okCount, failCount };
  });

  // ---------------- 下载记录 ----------------
  ipcMain.handle('downloads:list', () => store.listDownloads());
  ipcMain.handle('downloads:remove', (_, id) => store.deleteDownload(id));
  ipcMain.handle('downloads:clear', () => store.clearDownloads());

  ipcMain.handle('app:version', () => ({ name: app.getName(), version: app.getVersion() }));

  ipcMain.handle('rename:preview', (_, args) => preview(store, args.videoIds, args.ruleIds, args.useCurrentName));
  ipcMain.handle('rename:execute', (_, args) => execute(store, args.videoIds, args.ruleIds, args.useCurrentName));
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
function bootstrap() {
  loadSettings();
  fs.mkdirSync(STORAGE_DIR(), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR(), 'bin'), { recursive: true });
  store = new Store(DATA_DIR());
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
