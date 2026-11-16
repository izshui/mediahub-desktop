'use strict';
/**
 * 删除服务：删除播放列表 / 媒体库条目。
 *
 * 设计要点：
 *  - 记录与文件分离：可只删记录（保留文件），也可连同磁盘文件一起删；
 *  - 文件删除严格限定在存储目录之内（fileCleaner 负责路径校验）；
 *  - 下载记录保留为历史，仅把对应条目标记为「文件已删除」。
 */
const path = require('path');
const { removeFile, removeDir } = require('./fileCleaner');

/**
 * 删除播放列表：连带移除其下全部视频记录与改名历史。
 * deleteFiles=true 时一并删除该播放列表的媒体目录与音频文件。
 */
function removePlaylist(store, storageDir, playlistId, deleteFiles) {
  const pl = store.getPlaylist(playlistId);
  if (!pl) return { ok: false, error: '播放列表不存在' };

  const videos = store.listVideos(playlistId);
  const fileErrors = [];
  let removedFiles = 0;

  if (deleteFiles) {
    // 该播放列表独立的媒体目录
    const dir = path.join(storageDir, 'playlist_' + playlistId);
    const r = removeDir(storageDir, dir);
    if (r.ok) removedFiles += r.fileCount;
    else fileErrors.push(r.error);
    // 音频位于共享的 audio 目录，需逐个删除
    for (const v of videos) {
      if (!v.audio_path) continue;
      const r2 = removeFile(storageDir, v.audio_path);
      if (r2.ok) removedFiles += r2.fileCount;
      else fileErrors.push(r2.error);
    }
  }

  const removedVideos = store.deletePlaylist(playlistId);

  if (deleteFiles) {
    const gone = videos.map((v) => v.filepath).filter(Boolean)
      .concat(videos.map((v) => v.audio_path).filter(Boolean));
    store.markDownloadsMissing(gone);
  }

  return { ok: true, removedVideos, removedFiles, fileErrors };
}

/** 删除媒体库条目（支持单个或批量） */
function removeVideos(store, storageDir, videoIds, deleteFiles) {
  const ids = Array.isArray(videoIds) ? videoIds : [videoIds];
  if (!ids || ids.length === 0) return { ok: false, error: '未选择条目' };

  const fileErrors = [];
  const gone = [];
  let removedFiles = 0;
  let removedCount = 0;

  for (const id of ids) {
    const v = store.getVideo(id);
    if (!v) continue;
    if (deleteFiles) {
      for (const p of [v.filepath, v.audio_path]) {
        if (!p) continue;
        gone.push(p);
        const r = removeFile(storageDir, p);
        if (r.ok) removedFiles += r.fileCount;
        else fileErrors.push(r.error);
      }
    }
    store.deleteVideo(id);
    removedCount++;
  }

  if (gone.length > 0) store.markDownloadsMissing(gone);
  return { ok: true, removedCount, removedFiles, fileErrors };
}

module.exports = { removePlaylist, removeVideos };
