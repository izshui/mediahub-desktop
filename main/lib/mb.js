'use strict';
/**
 * 多字节（Unicode 码点）字符串助手。
 * 与 PHP mb_* 对齐：以"码点"计长，而非 UTF-16 代码单元。
 * 大部分中文在 BMP 内（1 码点 = 1 单元），但表情符号等会占 2 单元，
 * 故这里统一按码点处理，保证与 PHP 行为一致。
 */

function toPoints(str) {
  return Array.from(str);
}

/** 码点长度 */
function mbLen(str) {
  return Array.from(str).length;
}

/**
 * 子串（对齐 mb_substr）。
 * @param {number} start 起始（可为负，从末尾倒推）
 * @param {number|null} length 长度（null 表示到结尾）
 */
function mbSubstr(str, start, length = null) {
  const pts = Array.from(str);
  const n = pts.length;
  let s = start;
  if (s < 0) s = Math.max(0, n + s);
  if (s > n) s = n;
  if (length === null) return pts.slice(s).join('');
  if (length < 0) return pts.slice(s, Math.max(s, n + length)).join('');
  return pts.slice(s, s + length).join('');
}

function mbStrToLower(str) {
  return str.toLowerCase();
}

function mbStrToUpper(str) {
  return str.toUpperCase();
}

/** 首字母大写（标题化） */
function mbTitleCase(str) {
  return Array.from(str)
    .map((ch, i) => {
      if (i === 0) return ch.toLocaleUpperCase();
      return ch;
    })
    .join('');
}

module.exports = { mbLen, mbSubstr, mbStrToLower, mbStrToUpper, mbTitleCase, toPoints };
