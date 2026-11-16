'use strict';
/**
 * 轻量 JSON 文件存储（替代 MySQL，零原生依赖）。
 * 集合：playlists / videos / rules / history / downloads。自动持久化到 userData 下的 data.json。
 */
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ playlists: [], videos: [], rules: [], history: [], downloads: [] });

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'data.json');
    this.data = EMPTY();
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign(EMPTY(), raw);
      }
    } catch (e) { /* 损坏则重置 */ }
  }

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 200);
  }

  /** 立即同步落盘（防抖窗口内退出应用会导致数据丢失，退出前必须调用） */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  }

  _nextId(arr) {
    let max = 0;
    for (const r of arr) if (r.id > max) max = r.id;
    return max + 1;
  }

  // ---------------- playlists ----------------
  listPlaylists() { return this.data.playlists.slice().sort((a, b) => b.id - a.id); }
  getPlaylist(id) { return this.data.playlists.find((p) => p.id === id) || null; }
  /** 按链接查找已存在的播放列表（用于重复解析时复用记录，避免重复建单） */
  findPlaylistByUrl(url) {
    if (!url) return null;
    const key = String(url).trim();
    return this.data.playlists.find((p) => String(p.url || '').trim() === key) || null;
  }
  createPlaylist(row) {
    const id = this._nextId(this.data.playlists);
    const rec = Object.assign({ id, item_count: 0, status: 'pending', created_at: Date.now() }, row);
    this.data.playlists.push(rec);
    this.save();
    return rec;
  }
  updatePlaylist(id, patch) {
    const p = this.getPlaylist(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.save();
    return p;
  }

  // ---------------- videos ----------------
  listVideos(playlistId = null) {
    let v = this.data.videos;
    if (playlistId !== null) v = v.filter((x) => x.playlist_id === playlistId);
    return v.slice().sort((a, b) => (a.id - b.id));
  }
  getVideo(id) { return this.data.videos.find((v) => v.id === id) || null; }
  findVideoBySource(playlistId, sourceUrl) {
    return this.data.videos.find((v) => v.playlist_id === playlistId && v.source_url === sourceUrl) || null;
  }
  upsertVideo(row) {
    if (row.id) {
      const v = this.getVideo(row.id);
      if (v) { Object.assign(v, row); this.save(); return v; }
    }
    const id = this._nextId(this.data.videos);
    const rec = Object.assign({ id, status: 'pending', created_at: Date.now() }, row, { id });
    this.data.videos.push(rec);
    this.save();
    return rec;
  }
  updateVideo(id, patch) {
    const v = this.getVideo(id);
    if (!v) return null;
    Object.assign(v, patch);
    this.save();
    return v;
  }

  /** 删除视频记录（连带其改名历史；下载记录保留为历史） */
  deleteVideo(id) {
    this.data.videos = this.data.videos.filter((v) => v.id !== id);
    this.data.history = this.data.history.filter((h) => h.video_id !== id);
    this.save();
    return true;
  }

  /** 删除播放列表记录（连带其下全部视频与改名历史） */
  deletePlaylist(id) {
    const videoIds = this.data.videos.filter((v) => v.playlist_id === id).map((v) => v.id);
    this.data.videos = this.data.videos.filter((v) => v.playlist_id !== id);
    this.data.history = this.data.history.filter((h) => !videoIds.includes(h.video_id));
    this.data.playlists = this.data.playlists.filter((p) => p.id !== id);
    this.save();
    return videoIds.length;
  }

  // ---------------- rules ----------------
  listRules(enabledOnly = false) {
    let r = this.data.rules;
    if (enabledOnly) r = r.filter((x) => x.enabled);
    return r.slice().sort((a, b) => a.sort_order - b.sort_order);
  }
  getRule(id) { return this.data.rules.find((r) => r.id === id) || null; }
  saveRule(row) {
    if (row.id) {
      const r = this.getRule(row.id);
      if (r) { Object.assign(r, row); this.save(); return r; }
    }
    const id = this._nextId(this.data.rules);
    const rec = Object.assign({ id, enabled: true, sort_order: this.data.rules.length, created_at: Date.now() }, row, { id });
    this.data.rules.push(rec);
    this.save();
    return rec;
  }
  deleteRule(id) {
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    this.save();
    return true;
  }

  // ---------------- history ----------------
  listHistory(videoId = null) {
    let h = this.data.history;
    if (videoId !== null) h = h.filter((x) => x.video_id === videoId);
    return h.slice().sort((a, b) => b.id - a.id);
  }
  addHistory(row) {
    const id = this._nextId(this.data.history);
    const rec = Object.assign({ id, created_at: Date.now() }, row, { id });
    this.data.history.push(rec);
    this.save();
    return rec;
  }
  getHistory(id) { return this.data.history.find((h) => h.id === id) || null; }
  deleteHistory(id) {
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this.save();
  }

  // ---------------- downloads（下载记录，永久保留） ----------------
  /** 最新在前 */
  listDownloads(limit = 1000) {
    return this.data.downloads.slice().sort((a, b) => b.id - a.id).slice(0, limit);
  }
  addDownload(row) {
    const id = this._nextId(this.data.downloads);
    const rec = Object.assign({ id, downloaded_at: Date.now() }, row, { id });
    this.data.downloads.push(rec);
    this.save();
    return rec;
  }
  getDownload(id) { return this.data.downloads.find((d) => d.id === id) || null; }
  /** 按来源链接查历史下载记录（用于重复下载检测） */
  findDownloadBySource(sourceUrl) {
    if (!sourceUrl) return null;
    return this.data.downloads.find((d) => d.source_url === sourceUrl) || null;
  }
  /** 按文件路径查历史下载记录 */
  findDownloadByPath(filepath) {
    if (!filepath) return null;
    return this.data.downloads.find((d) => d.filepath === filepath) || null;
  }
  deleteDownload(id) {
    this.data.downloads = this.data.downloads.filter((d) => d.id !== id);
    this.save();
    return true;
  }
  clearDownloads() {
    this.data.downloads = [];
    this.save();
    return true;
  }

  /** 标记下载记录中对应文件已被删除（记录保留为历史，仅打标记） */
  markDownloadsMissing(paths) {
    const set = new Set(paths || []);
    if (set.size === 0) return 0;
    let n = 0;
    for (const d of this.data.downloads) {
      if (set.has(d.filepath) && !d.file_missing) { d.file_missing = true; n++; }
    }
    if (n > 0) this.save();
    return n;
  }
}

module.exports = { Store };
