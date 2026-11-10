'use strict';
/**
 * 简繁转换器（忠实移植 PHP CharsetConverter）。
 *
 * 优先级：
 *  1. 系统 opencc 命令（最准确，含词组转换）
 *  2. python3 + opencc 模块
 *  3. 内置 JSON 映射表（与 PHP 同款 s2t.json / t2s.json，零依赖兜底）
 *
 * 桌面版默认使用内置映射，完全离线可用。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mbLen, mbSubstr } = require('./mb');

let DATA_DIR = path.join(__dirname, '..', '..', 'charset-data');
let loaded = false;
let engine = null;
let s2tPhrases = {}, t2sPhrases = {};
let s2tSingle = {}, t2sSingle = {};
let s2tMaxLen = 2, t2sMaxLen = 2;

function setDataDir(dir) {
  DATA_DIR = dir;
  loaded = false;
}

function detectEngine() {
  if (engine !== null) return engine;
  // opencc 二进制
  const openccPath = which('opencc');
  if (openccPath) { engine = 'opencc'; return engine; }
  // python3 + opencc 模块
  const py = which('python3') || which('python');
  if (py) {
    const r = spawnSync(py, ['-c', 'import opencc'], { encoding: 'utf8' });
    if (r.status === 0) { engine = 'python-opencc'; return engine; }
  }
  engine = 'builtin';
  return engine;
}

function which(bin) {
  if (!bin) return null;
  if (bin.includes(path.sep)) {
    return fs.existsSync(bin) && fs.statSync(bin).isFile() ? bin : null;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const pExe = path.join(d, bin + '.exe');
    if (fs.existsSync(pExe)) return pExe;
  }
  return null;
}

function load() {
  if (loaded) return;
  loaded = true;
  s2tPhrases = {}; t2sPhrases = {};
  s2tSingle = {}; t2sSingle = {};
  s2tMaxLen = 2; t2sMaxLen = 2;

  for (const t of ['s2t', 't2s']) {
    const file = path.join(DATA_DIR, t + '.json');
    if (!fs.existsSync(file)) continue;
    let map;
    try {
      map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      continue;
    }
    const phrases = {}, single = {};
    let maxLen = 2;
    for (const [k, v] of Object.entries(map)) {
      if (!k || k === v) continue;
      const kLen = mbLen(k);
      if (kLen === 1) {
        single[k] = v;
      } else {
        (phrases[kLen] = phrases[kLen] || {})[k] = v;
        if (kLen > maxLen) maxLen = kLen;
      }
    }
    if (t === 's2t') { s2tPhrases = phrases; s2tSingle = single; s2tMaxLen = maxLen; }
    else { t2sPhrases = phrases; t2sSingle = single; t2sMaxLen = maxLen; }
  }
}

function convertExternal(text, target) {
  const eng = detectEngine();
  if (eng === 'opencc') {
    const bin = which('opencc');
    const cfg = target === 's2t' ? 's2t.json' : 't2s.json';
    const r = spawnSync(bin, ['-c', cfg], { input: text, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (r.status === 0 && (r.stdout || '').trim() !== '') return r.stdout.trim();
  } else if (eng === 'python-opencc') {
    const py = which('python3') || which('python');
    const code = `import sys;from opencc import OpenCC;sys.stdout.write(OpenCC("${target}").convert(sys.stdin.read()))`;
    const r = spawnSync(py, ['-c', code], { input: text, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    if (r.status === 0 && (r.stdout || '').trim() !== '') return r.stdout.trim();
  }
  return null;
}

function convertWithMap(text, target) {
  load();
  const isS2t = target === 's2t';
  const phrases = isS2t ? s2tPhrases : t2sPhrases;
  const single = isS2t ? s2tSingle : t2sSingle;
  const maxLen = isS2t ? s2tMaxLen : t2sMaxLen;

  if (Object.keys(phrases).length === 0 && Object.keys(single).length === 0) return text;

  const pts = Array.from(text);
  const n = pts.length;
  let out = '';
  let i = 0;
  while (i < n) {
    let matched = false;
    const upper = Math.min(maxLen, n - i);
    for (let L = upper; L >= 2; L--) {
      const slice = pts.slice(i, i + L).join('');
      const bucket = phrases[L];
      if (bucket && bucket[slice] !== undefined) {
        out += bucket[slice];
        i += L;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = pts[i];
    out += single[ch] !== undefined ? single[ch] : ch;
    i++;
  }
  return out;
}

function convert(text, target) {
  if (!text) return '';
  target = target === 't2s' ? 't2s' : 's2t';
  const viaExternal = convertExternal(text, target);
  if (viaExternal !== null) return viaExternal;
  return convertWithMap(text, target);
}

/** 供 UI 展示检测结果 */
function info() {
  load();
  return {
    engine: detectEngine(),
    s2t_single: Object.keys(s2tSingle).length,
    t2s_single: Object.keys(t2sSingle).length,
    dataDir: DATA_DIR,
  };
}

module.exports = { convert, setDataDir, info, detectEngine, which };
