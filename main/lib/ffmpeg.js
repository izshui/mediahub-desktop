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

    // ---- 音轨预检：没有音频流就直接转码必然报 "does not contain any stream" ----
    let source = input;
    let mergedTemp = null;
    const st = await this.streams(input);
    if (!st.audio) {
      // 尝试找到同目录的配对音频并合并（下载时音视频未分离的补救）
      const companion = await this.findCompanionAudio(input);
      if (companion) {
        const candidate = input.replace(/\.[^.]+$/u, '') + '.merged.mkv';
        const mr = await this.mergeStreams(input, companion, candidate);
        if (mr.ok) {
          source = mr.file;
          mergedTemp = mr.file;
          if (onProgress) onProgress(0, '已自动合并分离的音视频轨道');
        } else {
          return {
            ok: false,
            error: '该视频没有音频轨道，自动合并配对音频失败：' + mr.error,
          };
        }
      } else {
        return {
          ok: false,
          error: '该视频没有音频轨道，无法转换为音频。可能是下载时音视频未合并，请重新下载该条目。',
        };
      }
    }

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
    args.push('-i', this.absPath(source), '-vn');
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

    const duration = await this.probeDuration(source);
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
      if (mergedTemp) { try { fs.unlinkSync(mergedTemp); } catch (e) {} }
      return { ok: false, error: err.slice(0, 500) };
    }
    if (mergedTemp) { try { fs.unlinkSync(mergedTemp); } catch (e) {} }
    return { ok: true, error: null, duration };
  }

  absPath(p) {
    if (!p) return p;
    if (p[0] === '/' || p[0] === '\\' || /^[A-Za-z]:/i.test(p)) return p;
    return path.resolve(p);
  }

  /** 探测文件包含哪些流（视频/音频） */
  async streams(file) {
    const out = { video: false, audio: false, codecs: [] };
    if (!file || !fs.existsSync(file)) return out;
    if (which(this.ffprobe)) {
      const r = await run([
        this.ffprobe, '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file,
      ], { timeout: 60 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const [type, codec] = t.split(',');
        if (type === 'video') out.video = true;
        else if (type === 'audio') out.audio = true;
        if (codec) out.codecs.push(codec);
      }
      if (out.video || out.audio) return out;
    }
    // 回退：解析 ffmpeg -i 的输出
    const r2 = await run([this.ffmpeg, '-hide_banner', '-i', file], { timeout: 60 });
    const err = r2.stderr || '';
    out.video = /Stream #\d+.*Video:/i.test(err);
    out.audio = /Stream #\d+.*Audio:/i.test(err);
    return out;
  }

  /** 文件 stem：去扩展名 + 去平台 format 后缀（如 .f251） */
  stemOf(file) {
    const b = path.basename(file);
    return b.replace(/\.[^.]+$/, '').replace(/\.[fF]\d{2,4}$/u, '').trim();
  }

  /**
   * 在同目录寻找配对的音频文件。
   * 场景：yt-dlp 下载时若缺少 ffmpeg 无法合并，会把音视频分别存成两个文件
   *（同名但 format id 不同，如 xxx.f401.mp4 视频 + xxx.f251.webm 音频）。
   */
  async findCompanionAudio(videoFile) {
    const dir = path.dirname(videoFile);
    const target = this.stemOf(videoFile);
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return null; }
    for (const name of entries) {
      const p = path.join(dir, name);
      if (p === videoFile) continue;
      if (/\.info\.json$|\.ytdl$|-Frag\d+$/u.test(name)) continue;
      let st;
      try { if (!fs.statSync(p).isFile()) continue; } catch (e) { continue; }
      if (this.stemOf(p) !== target) continue;
      st = await this.streams(p);
      if (st.audio && !st.video) return p;
    }
    return null;
  }

  /**
   * 合并视频与音频流（不重新编码，仅封装）。
   * 默认输出 mkv：opus 音轨在 mp4 容器里属于实验特性，mp4 会直接失败。
   */
  async mergeStreams(videoFile, audioFile, outFile) {
    const args = [
      this.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
      '-i', this.absPath(videoFile),
      '-i', this.absPath(audioFile),
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
    ];
    if (path.extname(outFile).toLowerCase() === '.mp4') args.push('-strict', '-2');
    args.push(this.absPath(outFile));
    const r = await run(args, { timeout: 3600 });
    if (r.code !== 0 || !fs.existsSync(outFile)) {
      let err = (r.stderr || '').trim();
      if (err === '') err = '合并失败（退出码 ' + (r.code ?? '?') + '）';
      return { ok: false, error: err.slice(0, 400) };
    }
    return { ok: true, file: outFile };
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
