'use strict';
/**
 * 文件名安全处理（忠实移植 PHP FilenameSanitizer）。
 * 非法字符、保留名、长度截断（不破坏扩展名）。
 */
const { mbLen, mbSubstr } = require('./mb');

const ILLEGAL = /[\/\\:*?"<>|\x00-\x1F\x7F]/gu;

// Windows 保留设备名
const RESERVED = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

function splitExt(filename) {
  const m = filename.match(/^(.+)\.([A-Za-z0-9]{1,10})$/u);
  if (m) return { base: m[1], ext: m[2] };
  return { base: filename, ext: '' };
}

/** 清洗文件名主体（不含扩展名） */
function clean(name, replacement = '_') {
  name = (name || '').replace(ILLEGAL, replacement);
  name = name.replace(/^[\s\t\n\r\0\x0B.]+|[\s\t\n\r\0\x0B.]+$/g, '');
  name = name.replace(/\s+/gu, ' ');
  name = name.replace(/[\x00-\x1F\x7F]/gu, '');
  return name.trim();
}

/** 完整清洗一个文件名（含扩展名） */
function sanitize(filename, maxLength = 0, replacement = '_') {
  let { base, ext } = splitExt(filename);
  ext = ext ? '.' + ext : '';
  base = clean(base, replacement);

  const upper = base.toUpperCase();
  if (RESERVED.includes(upper)) {
    base = '_' + base;
  }

  if (maxLength > 0) {
    const maxBase = Math.max(1, maxLength - ext.length);
    if (mbLen(base) > maxBase) {
      base = mbSubstr(base, 0, maxBase);
      base = base.replace(/[ .\-_]+$/g, '');
    }
  }

  if (base === '') base = 'untitled';
  return base + ext;
}

/** 字节长度限制（部分文件系统按字节限制，如 ext4 255） */
function enforceByteLimit(filename, maxBytes = 200) {
  if (Buffer.byteLength(filename, 'utf8') <= maxBytes) return filename;
  let { base, ext } = splitExt(filename);
  ext = ext ? '.' + ext : '';
  const budget = Math.max(1, maxBytes - Buffer.byteLength(ext, 'utf8'));
  base = mbSubstr(base, 0, budget).replace(/[ .\-_]+$/g, '');
  return (base === '' ? 'untitled' : base) + ext;
}

/** 生成不冲突的文件名：name (1).ext */
function unique(filename, exists) {
  if (!exists(filename)) return filename;
  let { base, ext } = splitExt(filename);
  ext = ext ? '.' + ext : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = base + ' (' + i + ')' + ext;
    if (!exists(candidate)) return candidate;
  }
  return base + ' (' + Date.now() + ')' + ext;
}

module.exports = { clean, sanitize, enforceByteLimit, unique, splitExt };
