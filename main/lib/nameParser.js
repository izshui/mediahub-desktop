'use strict';
/**
 * 智能文件名解析器（忠实移植 PHP NameParser）。
 * 从原始视频标题提取结构化元信息：artist / title / episode / season / year / quality / group ...
 *
 * 另提供 analyze()：面向短视频类「噪声文件名」的深度分析，
 * 可剥离视频 ID、format 后缀、标签段，识别频道名并抽出核心标题。
 */

/** 标题常见分隔符（竖线类） */
const SEG_SPLIT = /\s*[｜|∥｜]\s*/gu;

/** 纯噪音片段：视频 ID / 哈希 / 纯数字 */
function isNoiseSegment(seg) {
  const t = (seg || '').trim();
  if (t === '') return true;
  if (/^\d+$/u.test(t)) return true;
  // 形如 mtLJ3-wNeLM / 1A2b3C-dEfGh 的平台 ID
  if (/^[A-Za-z0-9_-]{5,}$/u.test(t) && /\d/u.test(t) && /[A-Za-z]/u.test(t)) return true;
  return false;
}

/** 是否像频道 / 品牌名：不含中文、较短、纯字母数字符号 */
function looksLikeChannel(seg) {
  const t = (seg || '').trim();
  if (t === '' || t.length > 30) return false;
  if (/\p{Script=Han}/u.test(t)) return false;
  if (!/^[\p{L}\p{N}\s&.\-_'!]+$/u.test(t)) return false;
  return true;
}

/** 是否像画质标签 */
const QUALITY_RE = /^(2160p|4k|uhd|1440p|2k|1080p|1080i|720p|480p|360p|hd|sd)$/iu;

function parse(raw) {
  const result = {
    title: '',
    artist: '',
    subtitle: '',
    episode: null,
    season: null,
    year: null,
    quality: '',
    tags: [],
    group: '',
    clean: raw || '',
  };

  let s = (raw || '').trim();
  if (s === '') return result;

  // 1. 字幕组前缀：【xxx】形式（先于通用括号剥离）
  const gm = s.match(/^[\[【]([^\]】]{1,30})[\]】]/u);
  if (gm) {
    result.group = gm[1];
  }

  // 2. 提取方括号 / 圆括号 / 中文括号内容
  const tags = [];
  s = s.replace(/[\[【（(]([^\]】）)]{1,40})[\]】）)]/gu, (_, inner) => {
    inner = (inner || '').trim();
    if (inner !== '') tags.push(inner);
    return ' ';
  });
  s = s.replace(/\s+/gu, ' ').trim();

  // 3. 集数 / 季数
  const em = s.match(/(?:\bS(\d{1,2})\s*)?(?:E(?:p)?\.?\s*(\d{1,4})|第\s*(\d{1,4})\s*[集话話期])/iu);
  if (em) {
    if (em[1] !== undefined && em[1] !== '') result.season = parseInt(em[1], 10);
    let ep = em[2] !== undefined ? em[2] : '';
    if (ep === '') ep = em[3] !== undefined ? em[3] : '';
    if (ep !== '') result.episode = parseInt(ep, 10);
  }

  // 4. 年份
  const ym = s.match(/\b(19|20)\d{2}\b/u);
  if (ym) result.year = parseInt(ym[0], 10);

  // 5. 画质标签
  const qualityMap = {
    '2160p': '4K', '4k': '4K', 'uhd': '4K',
    '1440p': '2K', '1080p': '1080P', '1080i': '1080P',
    '720p': '720P', '480p': '480P', '360p': '360P',
    'hd': 'HD', 'sd': 'SD',
  };
  for (const t of tags) {
    const key = t.toLowerCase().trim();
    if (qualityMap[key]) result.quality = qualityMap[key];
  }
  // 画质也可能直接写在正文里（如 "Movie 2021 1080p x264"）
  if (!result.quality) {
    const qm = s.match(/(^|[\s._-])(2160p|1440p|1080[pi]|720p|480p|360p|4k|uhd|2k|hd|sd)(?=$|[\s._-])/iu);
    if (qm) {
      const key = qm[2].toLowerCase();
      if (qualityMap[key]) result.quality = qualityMap[key];
    }
  }

  // 6. Artist - Title 拆分（取最靠前的 " - "，且两段都够长）
  const sep = s.match(/^(.{1,60}?)\s+[-–—]\s+(.{2,})$/u);
  if (sep) {
    result.artist = sep[1].trim();
    result.title = sep[2].trim();
  } else {
    result.title = s;
  }

  // 7. 若 title 中还含 "Artist - Title"，二次拆分
  if (result.artist === '' && result.title.includes(' - ')) {
    const parts = result.title.split(' - ', 2).map((x) => x.trim());
    if (parts.length === 2) {
      result.artist = parts[0];
      result.title = parts[1];
    }
  }

  // 8. 剔除 title 中残留的集数标记
  result.title = (result.title || '').replace(
    /\s*(?:第\s*\d{1,4}\s*[集话話期]|\bS\d{1,2}E\d{1,4}\b|\bE(?:p)?\.?\s*\d{1,4}\b).*$/iu,
    ''
  ).trim();

  // 9. 副标题（Artist - Title - Subtitle）
  if (result.title.includes(' - ')) {
    const parts = result.title.split(' - ', 2);
    result.title = parts[0].trim();
    result.subtitle = parts[1].trim();
  }

  result.tags = tags;
  result.clean = (result.title || '').trim();
  return result;
}

/**
 * 深度分析：把噪声文件名拆成「核心标题 / 频道 / 标签」。
 *
 * 例：冰雪女王把未婚夫冻成冰雕！…？｜中文宣｜ KONDOSAN [mtLJ3-wNeLM].f251
 *   → core    = 冰雪女王把未婚夫冻成冰雕！…？
 *     channel = KONDOSAN
 *     tags    = [中文宣]
 *     noise   = [mtLJ3-wNeLM]
 */
function analyze(raw) {
  const base = parse(raw);
  let s = (raw || '').trim();

  // 去掉平台 format 后缀（如 .f251 / .f401 / .video）
  s = s.replace(/\.[fF]\d{2,4}\b/gu, '');

  // 抽走方括号内容，记为噪音（视频 ID 等）
  const noise = [];
  s = s.replace(/[\[【（(]([^\]】）)]{1,40})[\]】）)]/gu, (_, inner) => {
    const t = (inner || '').trim();
    if (t !== '') noise.push(t);
    return ' ';
  });
  s = s.replace(/\s+/gu, ' ').trim();

  // 按竖线分段
  const segs = s.split(SEG_SPLIT).map((x) => x.trim()).filter(Boolean);

  const tags = [];
  let channel = '';
  let core = '';

  for (const seg of segs) {
    if (isNoiseSegment(seg)) { noise.push(seg); continue; }
    if (QUALITY_RE.test(seg) && !base.quality) {
      tags.push(seg);
      continue;
    }
    // 已被基础解析识别为 artist 开头的段（Artist - Title），不当作频道
    if (base.artist && seg.startsWith(base.artist)) continue;
    if (!channel && looksLikeChannel(seg)) {
      channel = seg;
      continue;
    }
    if (!core) { core = seg; continue; }
    // 其余段落视为标签
    tags.push(seg);
  }

  // 核心标题为空时退回基础解析结果
  if (core === '') core = base.title || s;

  // 若基础解析已识别出 artist，则 core 取 artist 之后的部分
  if (base.artist && core.startsWith(base.artist)) {
    const rest = core.slice(base.artist.length).replace(/^\s*[-–—]\s*/u, '').trim();
    if (rest !== '') core = rest;
  }

  return {
    raw: raw || '',
    core: core.trim(),
    channel: channel || '',
    artist: base.artist || '',
    title: base.title || '',
    subtitle: base.subtitle || '',
    episode: base.episode,
    season: base.season,
    year: base.year,
    quality: base.quality,
    group: base.group,
    // 基础解析的方括号标签合并进来，但排除已判定为噪音的项
    tags: tags.concat((base.tags || []).filter((t) => !noise.includes(t))),
    noise: noise,
  };
}

/** 生成安全的 slug */
function slug(text, maxLen = 80) {
  let s = (text || '').toLowerCase().trim();
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/g, '');
  return s !== '' ? s : 'untitled';
}

module.exports = { parse, analyze, slug, isNoiseSegment, looksLikeChannel };
