'use strict';
/**
 * 下载服务：解析播放列表 + 下载视频（本地执行，文件留在本机）。
 *
 * 关键行为：
 *  - 解析同一链接时复用已有播放列表记录，不重复建单（下载记录永久保留）；
 *  - 下载前做重复检测，命中则交由上层提示用户确认（needConfirm）；
 *  - 每次成功下载都写入 downloads 集合，形成永久下载记录。
 */
const path = require('path');
const fs = require('fs');

function detectPlatform(url, extractor) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtube') || u.includes('youtu.be') || /youtube/.test(extractor || '')) return 'youtube';
  if (u.includes('facebook') || u.includes('fb.watch') || /facebook/.test(extractor || '')) return 'facebook';
  if (u.includes('twitter') || u.includes('x.com') || /twitter/.test(extractor || '')) return 'twitter';
  return 'other';
}

async function extractPlaylist(store, ytdlp, url, cookies, emit) {
  const res = await ytdlp.extractPlaylist(url, cookies || '');
  if (!res.ok) return res;
  const platform = detectPlatform(url, '');

  // 复用已有播放列表记录：同一链接重复解析不产生新单据，历史下载记录得以保留
  let playlist = store.findPlaylistByUrl(url);
  let reused = false;
  if (playlist) {
    reused = true;
    store.updatePlaylist(playlist.id, {
      title: res.title || playlist.title,
      platform,
      cookies: cookies || playlist.cookies || '',
      source_type: res.entries.length > 1 ? 'playlist' : 'single',
      last_parsed_at: Date.now(),
    });
  } else {
    playlist = store.createPlaylist({
      url, title: res.title || url, platform,
      source_type: res.entries.length > 1 ? 'playlist' : 'single',
      cookies: cookies || '',
      last_parsed_at: Date.now(),
    });
  }

  let added = 0, total = 0;
  for (const e of res.entries) {
    if (!e.url && !e.id) continue;
    total++;
    const existing = store.findVideoBySource(playlist.id, e.url || e.id);
    if (existing) {
      // 已存在的条目保持原状态（不重置为 pending），仅刷新元信息
      store.updateVideo(existing.id, {
        title: e.title || existing.title,
        uploader: e.uploader || existing.uploader,
        duration: e.duration || existing.duration,
      });
      continue;
    }
    store.upsertVideo({
      playlist_id: playlist.id,
      video_id: e.id,
      source_url: e.url || e.id,
      title: e.title,
      uploader: e.uploader,
      duration: e.duration,
      platform: detectPlatform(e.url, e.extractor),
      status: 'pending',
    });
    added++;
  }
  store.updatePlaylist(playlist.id, { item_count: total, new_count: added, status: 'ready' });
  if (emit) emit('playlist:ready', { playlistId: playlist.id, count: total, added, reused });
  return { ok: true, playlist, count: total, added, reused };
}

/**
 * 重复下载检测：命中任一条件即视为"重复下载"，需用户确认。
 *  1) 该来源在下载记录中已有成功记录；
 *  2) 目标目录中已存在同名文件；
 *  3) 视频记录里的文件仍存在于磁盘。
 */
function detectDuplicate(store, row, storageDir) {
  const rec = store.findDownloadBySource(row.source_url);
  if (rec) {
    const exists = rec.filepath && fs.existsSync(rec.filepath);
    return {
      reason: exists
        ? '「' + (row.title || rec.filename) + '」已下载过：' + path.basename(rec.filepath)
        : '「' + (row.title || rec.filename) + '」曾下载过（文件已不在原位置）：' + rec.filename,
      record: rec,
      fileExists: !!exists,
    };
  }
  const outputDir = path.join(storageDir, 'playlist_' + row.playlist_id);
  if (row.original_name) {
    const p = path.join(outputDir, row.original_name);
    if (fs.existsSync(p)) {
      return { reason: '目标文件已存在：' + row.original_name, filepath: p, fileExists: true };
    }
  }
  if (row.filepath && fs.existsSync(row.filepath)) {
    return { reason: '文件已存在：' + row.filepath, filepath: row.filepath, fileExists: true };
  }
  return null;
}

/** 批量预检：返回重复项列表（用于整批下载前提示） */
function detectDuplicates(store, videos, storageDir) {
  const out = [];
  for (const v of videos) {
    const d = detectDuplicate(store, v, storageDir);
    if (d) out.push(Object.assign({ id: v.id, title: v.title }, d));
  }
  return out;
}

async function downloadVideo(store, ytdlp, videoId, storageDir, emit, opts = {}) {
  const row = store.getVideo(videoId);
  if (!row) return { ok: false, error: '视频记录不存在' };

  if (!opts.force) {
    const dup = detectDuplicate(store, row, storageDir);
    if (dup) {
      return { ok: false, needConfirm: true, error: dup.reason, duplicate: dup };
    }
  }

  const outputDir = path.join(storageDir, 'playlist_' + row.playlist_id);
  fs.mkdirSync(outputDir, { recursive: true });
  store.updateVideo(videoId, { status: 'downloading' });

  // cookies 存在播放列表上（视频条目本身不保存）
  const playlist = store.getPlaylist(row.playlist_id);
  const cookies = row.cookies || (playlist && playlist.cookies) || '';

  const res = await ytdlp.download(row.source_url, outputDir, (pct, speed, eta, line) => {
    if (emit) emit('download:progress', { videoId, title: row.title || '', percent: pct, speed, eta });
  }, cookies, { concurrent_fragments: parseInt((opts && opts.concurrent_fragments) || 0, 10) });

  if (!res.ok) {
    store.updateVideo(videoId, { status: 'failed', error_message: res.error });
    if (emit) emit('download:done', { videoId, ok: false, error: res.error });
    return res;
  }
  const basename = path.basename(res.file);
  const downloadedAt = Date.now();
  store.updateVideo(videoId, {
    filepath: res.file,
    original_name: basename,
    current_name: basename,
    ext: path.extname(basename).replace('.', '').toLowerCase(),
    status: 'downloaded',
    duration: res.meta.duration || row.duration,
    meta: JSON.stringify(res.meta || {}),
    thumbnail: res.meta.thumbnail || '',
    downloaded_at: downloadedAt,
  });

  // 写入永久下载记录（同一来源再次下载会追加一条新记录，保留历史）
  store.addDownload({
    video_id: videoId,
    playlist_id: row.playlist_id,
    source_url: row.source_url,
    title: row.title || basename,
    uploader: row.uploader || '',
    platform: row.platform || (playlist && playlist.platform) || '',
    filepath: res.file,
    filename: basename,
    size: res.meta.filesize || 0,
    duration: res.meta.duration || row.duration || 0,
    downloaded_at: downloadedAt,
  });
  // 下载记录立即落盘：即使随后退出应用也不会丢
  if (typeof store.flush === 'function') store.flush();

  if (emit) emit('download:done', { videoId, ok: true, file: res.file });
  return { ok: true, file: res.file };
}

module.exports = { extractPlaylist, downloadVideo, detectPlatform, detectDuplicate, detectDuplicates };
