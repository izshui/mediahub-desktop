'use strict';
/**
 * 数据目录迁移。
 *
 * 背景：开发模式与打包版的 userData 目录名不同（开发版取自 package.json 的 name，
 * 打包版取自 productName），导致切换运行方式后「历史记录消失」。
 * 现在统一目录名，并把旧目录里的数据迁移过来。
 */
const fs = require('fs');
const path = require('path');

/**
 * 若目标目录尚无 data.json，而旧目录中存在，则把旧数据复制到目标目录。
 * @param {string} target  目标数据目录
 * @param {string} base    应用数据根目录（其下存放各版本的目录）
 * @param {string[]} legacyNames  旧目录名列表
 * @returns {{migrated:boolean, from:string}}
 */
function migrateDataDir(target, base, legacyNames) {
  const result = { migrated: false, from: '' };
  try {
    const targetFile = path.join(target, 'data.json');
    if (fs.existsSync(targetFile)) return result;
    for (const name of legacyNames || []) {
      const legacyDir = path.join(base, name);
      const legacyFile = path.join(legacyDir, 'data.json');
      if (!fs.existsSync(legacyFile)) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(legacyFile, targetFile);
      const legacySettings = path.join(legacyDir, 'settings.json');
      if (fs.existsSync(legacySettings)) {
        fs.copyFileSync(legacySettings, path.join(target, 'settings.json'));
      }
      result.migrated = true;
      result.from = name;
      return result;
    }
  } catch (e) { /* 迁移失败不阻断启动 */ }
  return result;
}

module.exports = { migrateDataDir };
