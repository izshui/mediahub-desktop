'use strict';
/**
 * yt-dlp 封装（忠实移植 PHP YtDlp）：解析播放列表、下载视频、探测元数据。
 */
const fs = require('fs');
const path = require('path');
const { run, stream, which } = require('./cmd');

const MEDIA_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts', 'mp3', 'm4a', 'opus', 'wav', 'flac', 'aac'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class YtDlp {
  constructor(binary = null) {
    this.binary = binary || 'yt-dlp';
  }

  binaryPath() { return this.binary; }
  available() { return which(this.binary) !== null; }
  version() {
    if (!this.available()) return '';
    return run([this.binary, '--version'], { timeout: 30 }).then((r) => r.stdout.trim());
  }

  async extractPlaylist(url, cookies = '', timeout = 300) {
    if (!this.available()) {
      return { ok: false, title: '', entries: [], error: '未找到 yt-dlp 可执行文件，请在设置中安装或指定路径' };
    }
    const args = [
      this.binary, '--flat-playlist', '--dump-single-json', '--no-warnings',
      '--ignore-errors', '--no-playlist-reverse', '--socket-timeout', '20',
    ];
    if (cookies && fs.existsSync(cookies)) {
      args.push('--cookies', cookies);
    }
    args.push('--', url);

    const r = await run(args, { timeout });
    const stdout = (r.stdout || '').trim();
    if (stdout === '') {
      const err = (r.stderr || '').trim();
      return { ok: false, title: '', entries: [], error: err ? err.slice(0, 500) : 'yt-dlp 未返回数据' };
    }
    let json;
    try { json = JSON.parse(stdout); } catch (e) {
      return { ok: false, title: '', entries: [], error: 'yt-dlp 返回的 JSON 无法解析' };
    }

    const entries = [];
    const raw = json.entries !== undefined ? json.entries : null;
    if (Array.isArray(raw)) {
      for (const e of raw) {
        if (e && typeof e === 'object') entries.push(this.normalizeEntry(e));
      }
    } else if (json.id || json.webpage_url || json.url) {
      entries.push(this.normalizeEntry(json));
    }
    return { ok: true, title: String(json.title || ''), entries, error: null };
  }

  normalizeEntry(e) {
    return {
      url: String(e.url || e.webpage_url || ''),
      id: String(e.id || ''),
      title: String(e.title || ''),
      uploader: String(e.uploader || e.channel || ''),
      duration: parseInt(e.duration || 0, 10),
      thumbnail: String(e.thumbnail || ''),
      playlist_index: parseInt(e.playlist_index || 0, 10),
      extractor: String(e.extractor_key || ''),
    };
  }

  async download(url, outputDir, onProgress = null, cookies = '', options = {}) {
    if (!this.available()) return { ok: false, file: null, error: '未找到 yt-dlp', meta: {} };
    ensureDir(outputDir);

    const format = options.format || 'bv*+ba/b';
    const merge = options.merge_format || 'mp4';
    const retries = parseInt(options.retries || 3, 10);
    const maxHeight = parseInt(options.max_height || 0, 10);
    const writeInfo = options.write_info_json !== undefined ? options.write_info_json : true;
    const extra = (options.extra_args || '').trim();

    const args = [
      this.binary, '--newline', '--no-color', '--no-warnings', '--no-playlist',
      '--no-part', '--retries', String(retries), '--fragment-retries', String(retries),
      '--socket-timeout', '30', '--format', format, '--merge-output-format', merge,
      '--output', path.join(outputDir, '%(title).150B [%(id)s].%(ext)s'),
      '--no-mtime',
    ];
    if (maxHeight > 0) { args.push('--format-sort', 'res:' + maxHeight); }
    if (writeInfo) { args.push('--write-info-json', '--no-clean-info-json'); }
    if (cookies && fs.existsSync(cookies)) { args.push('--cookies', cookies); }
    if (extra) {
      for (const a of extra.split(/\s+/).filter(Boolean)) args.push(a);
    }
    args.push('--', url);

    let lastPct = -1;
    const errLines = [];
    const r = await stream(args, (line) => {
      line = line.trim();
      if (line === '') return;
      const m = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/i);
      if (m) {
        const pct = parseFloat(m[1]);
        let speed = '', eta = '';
        const ms = line.match(/at\s+([\d.]+\w+\/s)/i);
        if (ms) speed = ms[1];
        const me = line.match(/ETA\s+(\S+)/i);
        if (me) eta = me[1];
        if (Math.abs(pct - lastPct) >= 0.5 || pct >= 99.9) {
          lastPct = pct;
          if (onProgress) onProgress(pct, speed, eta, line);
        }
        return;
      }
      if (/^(ERROR|WARNING):/i.test(line)) {
        errLines.push(line);
        if (onProgress) onProgress(lastPct < 0 ? 0 : lastPct, '', '', line);
      }
    }, { timeout: parseInt(options.timeout || 7200, 10) });

    if (r.code !== 0) {
      return { ok: false, file: null, error: this.extractError(errLines, r.stderr), meta: {} };
    }

    const file = this.locateOutput(outputDir);
    let meta = {};
    const infoJson = this.locateInfoJson(outputDir);
    if (infoJson) meta = this.readMeta(infoJson);
    return { ok: true, file, error: null, meta };
  }

  async probe(url, cookies = '', timeout = 120) {
    if (!this.available()) return { ok: false, error: '未找到 yt-dlp' };
    const args = [this.binary, '--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist'];
    if (cookies && fs.existsSync(cookies)) args.push('--cookies', cookies);
    args.push('--', url);
    const r = await run(args, { timeout });
    const out = (r.stdout || '').trim();
    if (out === '') return { ok: false, error: (r.stderr || '').trim() || '探测失败' };
    let j;
    try { j = JSON.parse(out); } catch (e) { return { ok: false, error: '无法解析元信息' }; }
    return { ok: true, meta: {
      id: String(j.id || ''), title: String(j.title || ''),
      uploader: String(j.uploader || j.channel || ''),
      duration: parseInt(j.duration || 0, 10),
      width: parseInt(j.width || 0, 10), height: parseInt(j.height || 0, 10),
      ext: String(j.ext || ''), filesize: parseInt(j.filesize || j.filesize_approx || 0, 10),
    } };
  }

  locateOutput(dir) {
    if (!fs.existsSync(dir)) return null;
    let best = null, bestTime = -1;
    for (const f of fs.readdirSync(dir)) {
      const ext = f.split('.').pop().toLowerCase();
      if (!MEDIA_EXT.includes(ext)) continue;
      const p = path.join(dir, f);
      if (!fs.statSync(p).isFile()) continue;
      const t = fs.statSync(p).mtimeMs;
      if (t > bestTime) { bestTime = t; best = p; }
    }
    return best;
  }

  locateInfoJson(dir) {
    if (!fs.existsSync(dir)) return null;
    let best = null, bestTime = -1;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.info.json')) continue;
      const p = path.join(dir, f);
      const t = fs.statSync(p).mtimeMs;
      if (t > bestTime) { bestTime = t; best = p; }
    }
    return best;
  }

  readMeta(file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        id: String(j.id || ''), title: String(j.title || ''),
        uploader: String(j.uploader || j.channel || ''),
        duration: parseInt(j.duration || 0, 10),
        width: parseInt(j.width || 0, 10), height: parseInt(j.height || 0, 10),
        ext: String(j.ext || ''), filesize: parseInt(j.filesize || j.filesize_approx || 0, 10),
        thumbnail: String(j.thumbnail || ''),
      };
    } catch (e) { return {}; }
  }

  extractError(lines, stderr) {
    if (lines.length) return lines.slice(0, 3).join(' | ').slice(0, 500);
    const s = (stderr || '').trim();
    if (s === '') return '下载失败（未知错误）';
    const keep = s.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').slice(-3);
    return keep.join(' | ').slice(0, 500);
  }
}

module.exports = { YtDlp };
