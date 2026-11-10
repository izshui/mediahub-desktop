'use strict';
/**
 * 并发池：最多 limit 路同时执行 worker(items[i])，用于多任务并行下载。
 * 单个任务异常不会中断整批。
 */
async function runPool(items, limit, worker) {
  const list = items || [];
  if (list.length === 0) return [];
  let idx = 0;
  const n = Math.max(1, Math.min(limit, list.length));
  const results = new Array(list.length);
  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      for (;;) {
        const k = idx++;
        if (k >= list.length) break;
        try {
          results[k] = await worker(list[k], k);
        } catch (e) {
          results[k] = { ok: false, error: e && e.message ? e.message : String(e) };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

module.exports = { runPool };
