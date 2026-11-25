'use strict';
/**
 * 重命名服务（忠实移植 PHP RenameService）：预览 + 执行 + 回滚。
 */
const fs = require('fs');
const path = require('path');
const { RenameEngine } = require('./renameEngine');
const { unique } = require('./sanitizer');

const engine = new RenameEngine();

function resolveRules(store, ruleIds) {
  if (ruleIds === null || ruleIds === undefined || (Array.isArray(ruleIds) && ruleIds.length === 0)) {
    return store.listRules(true);
  }
  const all = store.listRules(false);
  const want = ruleIds.map((x) => parseInt(x, 10));
  return all.filter((r) => want.includes(r.id) && r.enabled);
}

/** 本地文件改名：基于磁盘路径直接预览（不依赖数据库） */
function previewLocal(paths, rules) {
  if (!paths || paths.length === 0) return { ok: false, error: '未选择文件' };
  if (!rules || rules.length === 0) return { ok: false, error: '没有可用的改名规则，请先在右侧添加' };
  const items = paths.map((p, i) => ({ id: i, title: '', filename: path.basename(p), index: i, meta: { filepath: p } }));
  const result = engine.applyBatch(items, rules);
  const seen = {};
  for (const r of result) {
    const key = r.new_filename.toLowerCase();
    if (seen[key]) { r.conflict = true; seen[key]++; }
    else { r.conflict = false; seen[key] = 1; }
    r.filepath = paths[r.index];
  }
  return { ok: true, items: result, rule_ids: rules.map((r) => r.id), count: result.length };
}

/** 本地文件改名：真实重命名磁盘文件 */
function executeLocal(paths, rules) {
  const pv = previewLocal(paths, rules);
  if (!pv.ok) return pv;
  let renamed = 0, skipped = 0, failed = 0;
  const details = [];
  for (const item of pv.items) {
    const oldPath = item.filepath;
    const dir = path.dirname(oldPath);
    const oldName = path.basename(oldPath);
    let newName = item.new_filename;
    if (newName === oldName) {
      skipped++;
      details.push({ status: 'skipped', name: newName });
      continue;
    }
    let newPath = path.join(dir, newName);
    if (fs.existsSync(newPath) && newPath !== oldPath) {
      newName = unique(newName, (n) => fs.existsSync(path.join(dir, n)));
      newPath = path.join(dir, newName);
    }
    try {
      fs.renameSync(oldPath, newPath);
      renamed++;
      details.push({ status: 'renamed', from: oldName, to: newName });
    } catch (e) {
      failed++;
      details.push({ status: 'failed', name: newName, error: e.message });
    }
  }
  return { ok: failed === 0, renamed, skipped, failed, items: details };
}

function preview(store, videoIds, ruleIds, useCurrentName) {
  const videos = store.data.videos.filter((v) => videoIds.includes(v.id));
  if (videos.length === 0) return { ok: false, error: '未找到视频记录', items: [] };
  const rules = resolveRules(store, ruleIds);
  if (rules.length === 0) return { ok: false, error: '没有可用的改名规则', items: [] };

  const items = videos.map((v, i) => {
    const name = useCurrentName
      ? (v.current_name || '')
      : ((v.original_name || '') !== '' ? v.original_name : v.title);
    let meta = {};
    try { meta = v.meta ? JSON.parse(v.meta) : {}; } catch (e) { meta = {}; }
    meta.uploader = v.uploader || '';
    meta.platform = v.platform || '';
    meta.duration = v.duration || 0;
    return { id: v.id, title: v.title, filename: name, index: i, meta };
  });

  const result = engine.applyBatch(items, rules);

  const seen = {};
  for (const r of result) {
    const key = r.new_filename.toLowerCase();
    if (seen[key]) { r.conflict = true; seen[key]++; }
    else { r.conflict = false; seen[key] = 1; }
  }
  return { ok: true, items: result, rule_ids: rules.map((r) => r.id), count: result.length };
}

function execute(store, videoIds, ruleIds, useCurrentName) {
  const pv = preview(store, videoIds, ruleIds, useCurrentName);
  if (!pv.ok) return pv;
  const rules = resolveRules(store, ruleIds);
  const ruleIdsStr = rules.map((r) => r.id).join(',');

  let renamed = 0, skipped = 0, failed = 0;
  const details = [];
  for (const item of pv.items) {
    const vid = item.id;
    const row = store.getVideo(vid);
    if (!row) continue;
    const oldPath = row.filepath || '';
    const oldName = path.basename(oldPath);

    if (item.new_filename === oldName) {
      skipped++;
      details.push({ id: vid, status: 'skipped', name: oldName });
      continue;
    }

    if (oldPath === '' || !fs.existsSync(oldPath)) {
      store.updateVideo(vid, { current_name: item.new_filename });
      store.addHistory({ video_id: vid, old_name: oldName, new_name: item.new_filename, rule_ids: ruleIdsStr });
      renamed++;
      details.push({ id: vid, status: 'db_only', name: item.new_filename });
      continue;
    }

    const dir = path.dirname(oldPath);
    let newName = item.new_filename;
    let newPath = path.join(dir, newName);
    if (fs.existsSync(newPath) && newPath !== oldPath) {
      newName = unique(newName, (n) => fs.existsSync(path.join(dir, n)));
      newPath = path.join(dir, newName);
    }
    try {
      fs.renameSync(oldPath, newPath);
    } catch (e) {
      failed++;
      details.push({ id: vid, status: 'failed', name: newName, error: '重命名失败（权限或文件被占用）' });
      continue;
    }
    store.updateVideo(vid, {
      filepath: newPath,
      current_name: newName,
      ext: path.extname(newName).replace('.', '').toLowerCase(),
    });
    // 同步更新下载记录的文件路径：视频改名后，对应下载记录也要指向新路径，否则"文件已删除"
    if (typeof store.updateDownloadPathsByVideo === 'function') {
      store.updateDownloadPathsByVideo(vid, newPath);
    }
    store.addHistory({ video_id: vid, old_name: oldName, new_name: newName, rule_ids: ruleIdsStr });
    renamed++;
    details.push({ id: vid, status: 'renamed', from: oldName, to: newName });
  }
  return { ok: failed === 0, renamed, skipped, failed, items: details };
}

function revert(store, historyId) {
  const h = store.getHistory(historyId);
  if (!h) return { ok: false, error: '历史记录不存在' };
  const row = store.getVideo(h.video_id);
  if (!row) return { ok: false, error: '视频记录不存在' };
  const curPath = row.filepath || '';
  const dir = path.dirname(curPath);
  const targetName = h.old_name;
  const targetPath = path.join(dir, targetName);

  if (fs.existsSync(curPath) && !fs.existsSync(targetPath)) {
    try {
      fs.renameSync(curPath, targetPath);
      store.updateVideo(h.video_id, { filepath: targetPath, current_name: targetName });
      return { ok: true, message: '已回滚为: ' + targetName };
    } catch (e) {
      return { ok: false, error: '回滚失败：文件操作错误' };
    }
  }
  store.updateVideo(h.video_id, { current_name: targetName });
  return { ok: true, message: '已回滚记录（物理文件未变动）' };
}

module.exports = { preview, execute, revert, resolveRules, previewLocal, executeLocal };
