'use strict';
/**
 * 智能命名：把噪声文件名清洗并重组为规范、吸引人的名称。
 *
 * 目标（对应「去掉无用字符，然后根据已有内容重新编一个合适吸引人的名字」）：
 *   1. 剥离噪音：视频 ID、format 后缀、画质/分组标签、平台标记；
 *   2. 抽出核心标题：真正承载信息的那一段；
 *   3. 识别频道 / 作者，作为前缀或后缀；
 *   4. 规范化标点与空白，可选去掉表情符号。
 */
const { analyze } = require('./nameParser');

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu;

/** 去掉表情符号 */
function stripEmoji(text) {
  return String(text || '')
    .replace(EMOJI_RE, '')
    .replace(/[\u{FE0F}\u{20E3}]/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/** 规范化：残留竖线、多连字符、多余空白、标点前后空格 */
function tidy(text) {
  return String(text || '')
    .replace(/\s*[｜|∥]\s*/gu, ' ')
    .replace(/\s*[-–—]{2,}\s*/gu, ' - ')
    .replace(/\s+([，。！？、：；,.!?])/gu, '$1')
    .replace(/([，。！？、：；,.!?])\s+/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/**
 * 清洗原始文件名，返回结构化结果。
 * opts: { strip_emoji: bool, channel_as_artist: bool }
 */
function clean(raw, opts = {}) {
  const info = analyze(raw);
  let core = info.core || info.title || '';
  if (opts.strip_emoji) core = stripEmoji(core);
  core = tidy(core);

  const channel = info.channel || '';
  const artist = info.artist || (opts.channel_as_artist !== false ? channel : '');

  return Object.assign({}, info, { core, channel, artist });
}

/** 默认组装：作者/频道 - 核心标题 */
function compose(info) {
  const parts = [];
  if (info.artist) parts.push(info.artist);
  if (info.episode !== null && info.episode !== undefined) {
    parts.push('E' + String(info.episode).padStart(2, '0'));
  }
  parts.push(info.core || info.title || '');
  return parts.join(' - ').replace(/\s{2,}/gu, ' ').trim();
}

module.exports = { clean, compose, stripEmoji, tidy };
