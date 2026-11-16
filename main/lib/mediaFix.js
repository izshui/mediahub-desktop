'use strict';
/**
 * 媒体完整性修复。
 *
 * 背景：yt-dlp 下载分离流（bv*+ba）时若找不到 ffmpeg，会把视频与音频分别保存为
 * 两个文件（同名但平台 format id 不同，如 `xxx.f401.mp4` 视频 + `xxx.f251.webm` 音频），
 * 导致后续「转音频」因视频无音轨而失败。
 *
 * 本模块在下载完成后检查产物的流构成，必要时用 ffmpeg 重新合并。
 */
const fs = require('fs');
const path = require('path');

/**
 * 确保文件带音频轨；缺失时尝试与同目录的配对音频合并。
 * 返回 { ok, changed, file, reason, companion }
 */
async function ensureAudioTrack(ffmpeg, file) {
  if (!ffmpeg || !file) return { ok: true, changed: false, file };

  const st = await ffmpeg.streams(file);
  if (st.audio) return { ok: true, changed: false, file };

  const companion = await ffmpeg.findCompanionAudio(file);
  if (!companion) {
    return {
      ok: false,
      changed: false,
      file,
      reason: '视频没有音频轨道，同目录也未找到配对的音频文件（可能是下载时未合并，建议重新下载）',
    };
  }

  const target = file.replace(/\.[^.]+$/u, '') + '.merged.mkv';
  const r = await ffmpeg.mergeStreams(file, companion, target);
  if (!r.ok) {
    return { ok: false, changed: false, file, reason: '自动合并失败：' + r.error, companion };
  }
  return { ok: true, changed: true, file: r.file, companion };
}

/** 清理下载中断留下的临时碎片（.ytdl / -FragN） */
function cleanDownloadLeftovers(dir) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of entries) {
    if (/\.ytdl$|-Frag\d+$/u.test(name)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); n++; } catch (e) {}
    }
  }
  return n;
}

module.exports = { ensureAudioTrack, cleanDownloadLeftovers };
