'use strict';
/**
 * 文件清理：删除应用自身管理的媒体文件。
 *
 * 安全约束：所有删除操作的目标路径必须位于存储目录（storageDir）之内，
 * 杜绝路径穿越（../）或误删存储目录之外的系统文件。
 */
const fs = require('fs');
const path = require('path');

/** 目标是否在 base 目录之内（含 base 本身） */
function isInside(base, target) {
  if (!base || !target) return false;
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (t === b) return true;
  const rel = path.relative(b, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 统计目录内的文件数（用于告知用户将删除多少文件） */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** 删除单个文件（仅限 storageDir 内） */
function removeFile(storageDir, filepath) {
  if (!filepath) return { ok: false, error: '路径为空' };
  if (!isInside(storageDir, filepath)) {
    return { ok: false, error: '拒绝删除存储目录之外的路径：' + filepath };
  }
  try {
    if (!fs.existsSync(filepath)) return { ok: true, removed: false, fileCount: 0 };
    fs.rmSync(filepath, { force: true });
    return { ok: true, removed: true, fileCount: 1 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 删除目录及其全部内容（仅限 storageDir 内，且不可删存储根目录） */
function removeDir(storageDir, dirpath) {
  if (!dirpath) return { ok: false, error: '路径为空' };
  if (!isInside(storageDir, dirpath)) {
    return { ok: false, error: '拒绝删除存储目录之外的路径：' + dirpath };
  }
  if (path.resolve(dirpath) === path.resolve(storageDir)) {
    return { ok: false, error: '拒绝删除存储根目录' };
  }
  try {
    if (!fs.existsSync(dirpath)) return { ok: true, removed: false, fileCount: 0 };
    const n = countFiles(dirpath);
    fs.rmSync(dirpath, { recursive: true, force: true });
    return { ok: true, removed: true, fileCount: n };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { isInside, countFiles, removeFile, removeDir };
