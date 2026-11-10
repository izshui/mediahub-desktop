'use strict';
/**
 * 转码服务：视频转音频（ffmpeg，本地执行）。
 */
const path = require('path');
const fs = require('fs');

async function convertVideo(store, ffmpeg, videoId, opts, storageDir, emit) {
  const row = store.getVideo(videoId);
  if (!row) return { ok: false, error: '视频记录不存在' };
  const input = row.filepath;
  if (!input || !fs.existsSync(input)) return { ok: false, error: '视频文件不存在: ' + (input || '') };

  const format = (opts && opts.format) || 'mp3';
  const audioDir = path.join(storageDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const base = path.basename(input, path.extname(input));
  const output = path.join(audioDir, base + '.' + format);

  store.updateVideo(videoId, { status: 'converting' });
  const res = await ffmpeg.extractAudio(input, output, opts || {}, (pct) => {
    if (emit) emit('convert:progress', { videoId, percent: pct });
  });

  if (!res.ok) {
    store.updateVideo(videoId, { status: 'downloaded', error_message: res.error });
    if (emit) emit('convert:done', { videoId, ok: false, error: res.error });
    return res;
  }
  store.updateVideo(videoId, { audio_path: output, status: 'converted' });
  if (emit) emit('convert:done', { videoId, ok: true, file: output });
  return { ok: true, file: output };
}

module.exports = { convertVideo };
