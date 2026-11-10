'use strict';
/**
 * ffmpeg 封装（忠实移植 PHP FFmpeg）：视频转音频、探测时长、读取标签。
 */
const fs = require('fs');
const path = require('path');
const { run, stream, which } = require('./cmd');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class FFmpeg {
  constructor(ffmpeg = null, ffprobe = null) {
    this.ffmpeg = ffmpeg || 'ffmpeg';
    this.ffprobe = ffprobe || 'ffprobe';
    this._hwaccels = null;   // 硬件解码能力缓存
    this._hwaccelChecked = false;
  }

  available() { return which(this.ffmpeg) !== null; }

  async version() {
    if (!this.available()) return '';
    const r = await run([this.ffmpeg, '-version'], { timeout: 30 });
    const line = (r.stdout || '').split('\n')[0] || '';
    return line.trim();
  }

  /**
   * 探测本机 ffmpeg 支持的硬件解码器（macOS 上通常是 videotoolbox，可调用 GPU 解码省 CPU）。
   * 结果缓存，只探测一次。
   */
  async hwaccels() {
    if (this._hwaccelChecked) return this._hwaccels;
    this._hwaccelChecked = true;
    this._hwaccels = [];
    if (!this.available()) return this._hwaccels;
    try {
      const r = await run([this.ffmpeg, '-hide_banner', '-hwaccels'], { timeout: 20 });
      if (r.code === 0) {
        this._hwaccels = (r.stdout || '').split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && s !== 'Hardware acceleration methods:');
      }
    } catch (e) { /* 探测失败则不启用 */ }
    return this._hwaccels;
  }

  /** 选一个可用的硬件解码器（按平台优先级） */
  async pickHwaccel() {
    const list = await this.hwaccels();
    if (list.length === 0) return null;
    const prefer = process.platform === 'darwin'
      ? ['videotoolbox', 'videotoolbox_vld']
      : ['cuda', 'nvdec', 'vaapi', 'qsv', 'd3d11va'];
    for (const p of prefer) {
      if (list.includes(p)) return p;
    }
    return null;
  }

  async extractAudio(input, output, opts = {}, onProgress = null) {
    if (!this.available()) return { ok: false, error: '未找到 ffmpeg 可执行文件' };
    if (!fs.existsSync(input)) return { ok: false, error: '输入文件不存在: ' + input };

    const format = opts.format || 'mp3';
    const bitrate = opts.bitrate || '192k';
    const sampleRate = parseInt(opts.sample_rate || 44100, 10);
    const channels = parseInt(opts.channels || 2, 10);
    const normalize = !!opts.normalize;
    const keepMeta = opts.keep_metadata !== undefined ? opts.keep_metadata : true;
    const metadata = opts.metadata || {};
    const timeout = parseInt(opts.timeout || 3600, 10);

    const codec = {
      mp3: ['libmp3lame', bitrate, 'mp3'],
      m4a: ['aac', bitrate, 'ipod'],
      aac: ['aac', bitrate, 'adts'],
      flac: ['flac', null, 'flac'],
      opus: ['libopus', bitrate, 'ogg'],
      wav: ['pcm_s16le', null, 'wav'],
      ogg: ['libvorbis', bitrate, 'ogg'],
    }[format] || ['libmp3lame', bitrate, 'mp3'];

    let sr = sampleRate;
    if (codec[0] === 'libopus' && ![48000, 24000, 16000, 12000, 8000].includes(sr)) sr = 48000;

    ensureDir(path.dirname(output));

    const args = [
      this.ffmpeg, '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1',
      '-nostats', '-y',
    ];
    // 硬件解码：调用本机 GPU（macOS=VideoToolbox）解码视频，显著降低 CPU 占用
    const hw = opts.hwaccel === false ? null : await this.pickHwaccel();
    if (hw) args.push('-hwaccel', hw);
    args.push('-i', this.absPath(input), '-vn');
    // 多线程：用满 CPU 核心（0 = 自动）
    const threads = opts.threads !== undefined ? parseInt(opts.threads, 10) : 0;
    if (threads >= 0) args.push('-threads', String(threads));
    if (codec[1] !== null) { args.push('-b:a', codec[1]); }
    args.push('-ar', String(sr), '-ac', String(channels), '-c:a', codec[0]);
    args.push('-f', codec[2]);
    if (normalize) { args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'); }

    if (keepMeta) {
      const metaMap = { title: 'title', artist: 'artist', album: 'album', genre: 'genre', date: 'date', comment: 'comment' };
      for (const [key, tag] of Object.entries(metaMap)) {
        const v = String(metadata[key] || '');
        if (v !== '') { args.push('-metadata', tag + '=' + v); }
      }
    }
    args.push(output);

    const duration = await this.probeDuration(input);
    let lastPct = -1;
    const r = await stream(args, (line) => {
      if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
        const us = parseInt(line.slice(line.indexOf('=') + 1), 10);
        if (duration > 0 && us > 0) {
          const pct = Math.min(99.9, (us / 1_000_000) / duration * 100);
          if (Math.abs(pct - lastPct) >= 0.5 || pct >= 99.5) {
            lastPct = pct;
            if (onProgress) onProgress(pct, line);
          }
        }
        return;
      }
      if (/^(error|Error)/i.test(line) && onProgress) onProgress(lastPct < 0 ? 0 : lastPct, line);
    }, { timeout });

    if (r.code !== 0 || !fs.existsSync(output)) {
      let err = (r.stderr || '').trim();
      if (err === '') err = 'ffmpeg 转码失败（退出码 ' + (r.code ?? '?') + '）';
      return { ok: false, error: err.slice(0, 500) };
    }
    return { ok: true, error: null, duration };
  }

  absPath(p) {
    if (!p) return p;
    if (p[0] === '/' || p[0] === '\\' || /^[A-Za-z]:/i.test(p)) return p;
    return path.resolve(p);
  }

  async probeDuration(file) {
    if (!fs.existsSync(file)) return 0;
    if (which(this.ffprobe)) {
      const r = await run([
        this.ffprobe, '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file,
      ], { timeout: 60 });
      const out = (r.stdout || '').trim();
      if (out !== '' && !isNaN(out)) return Math.round(parseFloat(out));
    }
    const r2 = await run([this.ffmpeg, '-hide_banner', '-i', file], { timeout: 60 });
    const err = r2.stderr || '';
    const m = err.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) return Math.round(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
    return 0;
  }

  async readTags(file) {
    if (!fs.existsSync(file)) return {};
    if (which(this.ffprobe)) {
      const r = await run([
        this.ffprobe, '-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file,
      ], { timeout: 60 });
      try {
        const j = JSON.parse(r.stdout || '{}');
        const tags = (j.format && j.format.tags) || {};
        const out = {};
        for (const [k, v] of Object.entries(tags)) out[k.toLowerCase()] = String(v);
        return out;
      } catch (e) { /* fallthrough */ }
    }
    const r2 = await run([this.ffmpeg, '-hide_banner', '-i', file], { timeout: 60 });
    const err = r2.stderr || '';
    const out = {};
    const mm = err.matchAll(/^\s{4}([A-Za-z_]+)\s*:\s*(.+)$/gm);
    for (const set of mm) {
      const key = set[1].toLowerCase();
      if (!out[key]) out[key] = set[2].trim();
    }
    return out;
  }
}

module.exports = { FFmpeg };
