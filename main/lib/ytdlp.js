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

  /** 统一的代理参数：把应用设置的代理转成 yt-dlp 的 --proxy 参数 */
  static proxyArgs(proxy) {
    const p = (proxy || '').trim();
    return p ? ['--proxy', p] : [];
  }

  async extractPlaylist(url, cookies = '', timeout = 300, proxy = '') {
    if (!this.available()) {
      return { ok: false, title: '', entries: [], error: '未找到 yt-dlp 可执行文件，请在设置中安装或指定路径' };
    }
    const args = [
      this.binary, '--flat-playlist', '--dump-single-json', '--no-warnings',
      '--ignore-errors', '--no-playlist-reverse', '--socket-timeout', '20',
      ...YtDlp.proxyArgs(proxy),
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
    // 合并容器：留空则由 yt-dlp 自动挑选最合适的（opus 音轨在 mp4 里属实验特性会失败）
    const merge = (options.merge_format || '').trim();
    const retries = parseInt(options.retries || 3, 10);
    const maxHeight = parseInt(options.max_height || 0, 10);
    const writeInfo = options.write_info_json !== undefined ? options.write_info_json : true;
    const extra = (options.extra_args || '').trim();
    // 分片并发：HLS/DASH 流可多路同时拉取，吃满带宽与 CPU
    const fragments = parseInt(options.concurrent_fragments || 0,  10);
    // 显式指定 ffmpeg 位置：否则 yt-dlp 找不到 ffmpeg 就无法合并音视频
    const ffmpegPath = (options.ffmpeg_path || '').trim();

    const args = [
      this.binary, '--newline', '--no-color', '--no-warnings', '--no-playlist',
      '--no-part', '--retries', String(retries), '--fragment-retries', String(retries),
      '--socket-timeout', '30', '--format', format,
      '--output', path.join(outputDir, '%(title).150B [%(id)s].%(ext)s'),
      '--no-mtime',
      ...YtDlp.proxyArgs(options.proxy),
    ];
    if (merge) args.push('--merge-output-format', merge);
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
    // 让 yt-dlp 把最终产物路径写入独立文件：并发下载时不会被同目录的其他文件干扰
    // 注意：--print-to-file 需要两个参数 [WHEN:]TEMPLATE FILE，写成单个冒号拼接会被解析为额外 URL
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const pathFile = '.mh-path-' + uid + '.txt';
    args.push('--print-to-file', 'after_move:filepath', pathFile);
    if (maxHeight > 0) { args.push('--format-sort', 'res:' + maxHeight); }
    if (writeInfo) { args.push('--write-info-json', '--no-clean-info-json'); }
    if (cookies && fs.existsSync(cookies)) { args.push('--cookies', cookies); }
    if (fragments > 1) { args.push('--concurrent-fragments', String(fragments)); }
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
    }, { timeout: parseInt(options.timeout || 7200, 10), cwd: outputDir, control: options.control || null });

    if (r.code !== 0) {
      this.cleanupPathFile(outputDir, pathFile);
      return { ok: false, file: null, error: this.extractError(errLines, r.stderr, options.proxy), meta: {} };
    }

    // 优先使用 yt-dlp 回传的精确路径；失败再退回按时间猜测
    let file = this.readPrintedPath(outputDir, pathFile);
    this.cleanupPathFile(outputDir, pathFile);
    if (!file) file = this.locateOutput(outputDir);

    let meta = {};
    const infoPath = file ? this.infoJsonFor(file) : null;
    const infoJson = (infoPath && fs.existsSync(infoPath)) ? infoPath : this.locateInfoJson(outputDir);
    if (infoJson) meta = this.readMeta(infoJson);
    return { ok: true, file, error: null, meta };
  }

  /** 读取 yt-dlp 通过 --print-to-file 写下的最终产物路径 */
  readPrintedPath(outputDir, pathFile) {
    try {
      const p = path.join(outputDir, pathFile);
      if (!fs.existsSync(p)) return null;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return null;
      return lines[lines.length - 1];
    } catch (e) {
      return null;
    }
  }

  cleanupPathFile(outputDir, pathFile) {
    try { fs.unlinkSync(path.join(outputDir, pathFile)); } catch (e) {}
  }

  /** 由最终文件路径推导对应的 .info.json（并发时不会被同目录其他文件干扰） */
  infoJsonFor(file) {
    if (!file) return null;
    const i = file.lastIndexOf('.');
    return i > 0 ? file.slice(0, i) + '.info.json' : null;
  }

  async probe(url, cookies = '', timeout = 120, proxy = '') {
    if (!this.available()) return { ok: false, error: '未找到 yt-dlp' };
    const args = [this.binary, '--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist', ...YtDlp.proxyArgs(proxy)];
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

  extractError(lines, stderr, proxy) {
    let msg;
    if (lines.length) msg = lines.slice(0, 3).join(' | ').slice(0, 500);
    else {
      const s = (stderr || '').trim();
      if (s === '') return '下载失败（未知错误）';
      const keep = s.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').slice(-3);
      msg = keep.join(' | ').slice(0, 500);
    }
    // 403 常见于代理未生效 / 代理节点被封 / 缺少 cookie，给出可操作提示
    if (/403|forbidden/i.test(msg)) {
      const tip = proxy
        ? '（当前已配置代理 ' + proxy + '，若节点失效请到「设置」更换；部分视频需登录 cookie，可在解析时填入）'
        : '（未在「设置」配置网络代理，国内访问 YouTube 需先设置代理）';
      return msg + ' ' + tip;
    }
    return msg;
  }
}

module.exports = { YtDlp };
