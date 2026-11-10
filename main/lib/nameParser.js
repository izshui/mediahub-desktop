'use strict';
/**
 * 智能文件名解析器（忠实移植 PHP NameParser）。
 * 从原始视频标题提取结构化元信息：artist / title / episode / season / year / quality / group ...
 */

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

/** 生成安全的 slug */
function slug(text, maxLen = 80) {
  let s = (text || '').toLowerCase().trim();
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/g, '');
  return s !== '' ? s : 'untitled';
}

module.exports = { parse, slug };
