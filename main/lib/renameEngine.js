'use strict';
/**
 * 重命名引擎：规则管线（忠实移植 PHP RenameEngine）。
 *
 * 每条规则按 sort_order 依次作用在"文件名主体"（不含扩展名）上。
 * 支持 13 种 rule_type：template / field_limit / s2t / t2s / delete / add /
 * replace / case / trim / sanitize / smart / slug / transliterate。
 */
const { mbLen, mbSubstr, mbStrToLower, mbStrToUpper, mbTitleCase } = require('./mb');
const { parse: parseName, slug: makeSlug, analyze: analyzeName } = require('./nameParser');
const { clean: cleanName, compose: composeName } = require('./smartName');
const { convert: convertCharset } = require('./charset');
const { clean: sanitizeClean } = require('./sanitizer');

class ExtChange {
  constructor(base, ext) {
    this.base = base;
    this.ext = ext;
  }
}

const TYPES = [
  'template', 'field_limit', 's2t', 't2s', 'delete', 'add',
  'replace', 'case', 'trim', 'sanitize', 'smart', 'slug', 'transliterate',
];

function extractExt(filename) {
  const m = filename.match(/\.([A-Za-z0-9]{1,10})$/u);
  return m ? m[1] : '';
}
function stripExt(filename) {
  const m = filename.match(/^(.+)\.([A-Za-z0-9]{1,10})$/u);
  return m ? m[1] : filename;
}

class RenameEngine {
  /** 对一批文件执行规则 */
  applyBatch(items, rules) {
    rules = this.normalizeRules(rules);
    const ctxs = items.map((it) => ({
      id: parseInt(it.id || 0, 10),
      title: String(it.title || ''),
      filename: String(it.filename || ''),
      index: parseInt(it.index || 0, 10),
      meta: it.meta || {},
    }));
    return ctxs.map((ctx) => this.applyOne(ctx, rules));
  }

  applyOne(ctx, rules) {
    const original = ctx.filename;
    let ext = extractExt(original);
    let base = stripExt(original);
    const steps = [];
    let error = null;

    for (const rule of rules) {
      const type = rule.rule_type;
      const params = rule.params || {};
      try {
        let ret = this.applyRule(type, params, base, ext, ctx);
        if (ret instanceof ExtChange) {
          ext = ret.ext;
          const note = ret.note || '';
          ret = ret.base;
          // note 用于标记扩展名变化（在下面统一处理）
          if (note) {
            if (ret !== base) steps.push({ rule: type, from: base, to: ret, note });
            else steps.push({ rule: type, from: base, to: base, note });
          }
        }
        if (ret !== base) {
          steps.push({ rule: type, from: base, to: ret, note: '' });
          base = ret;
        }
      } catch (e) {
        error = e.message;
        steps.push({ rule: type, error });
      }
    }

    const newFilename = base + (ext !== '' ? '.' + ext : '');
    return {
      index: ctx.index,
      id: ctx.id,
      original,
      new_base: base,
      new_filename: newFilename,
      steps,
      error,
    };
  }

  applyRule(type, p, base, ext, ctx) {
    switch (type) {
      case 'template':
        return [this.renderTemplate(p.template || '{title}', base, ext, ctx), '模板'][0];
      case 'field_limit':
        return this.applyFieldLimit(base, ext, p);
      case 's2t':
        return this.wrap(convertCharset(base, 's2t'), '简转繁');
      case 't2s':
        return this.wrap(convertCharset(base, 't2s'), '繁转简');
      case 'delete':
        return this.wrap(this.applyDelete(base, p), '批量删除');
      case 'add':
        return this.wrap(this.applyAdd(base, p, ctx), '批量增加');
      case 'replace':
        return this.wrap(this.applyReplace(base, p), '查找替换');
      case 'case':
        return this.wrap(this.applyCase(base, p.mode || 'lower'), '大小写');
      case 'trim': {
        const chars = p.chars !== undefined ? p.chars : ' \t\n\r';
        const mode = p.mode || 'both';
        let r = base;
        if (mode === 'left') r = ltrim(base, chars);
        else if (mode === 'right') r = rtrim(base, chars);
        else r = base.trim();
        return this.wrap(r, '去首尾');
      }
      case 'sanitize': {
        const repl = p.replacement !== undefined ? p.replacement : '_';
        let r = sanitizeClean(base, repl);
        if (p.collapse_space) r = r.replace(/\s+/gu, ' ');
        return this.wrap(r, '非法字符清理');
      }
      case 'smart':
        return this.wrap(this.applySmart(base, p, ctx), '智能生成');
      case 'slug':
        return this.wrap(makeSlug(base, parseInt(p.max_length || 80, 10)), 'slug');
      case 'transliterate':
        return this.wrap(this.transliterate(base), '音译');
      default:
        return base;
    }
  }

  // 让规则返回带说明（兼容 ExtChange 路径的 note 处理）
  wrap(value, _note) {
    return value;
  }

  renderTemplate(tpl, base, ext, ctx, info) {
    const parsed = parseName(ctx.title !== '' ? ctx.title : base);
    const meta = ctx.meta || {};
    const index = parseInt(ctx.index || 0, 10);

    // 清洗后的信息（智能生成规则会传入），缺省时退回基础解析
    const cleanTitle = info ? (info.core || info.title || parsed.title) : parsed.title;
    const channel = info ? (info.channel || '') : '';
    const artistName = info ? (info.artist || '') : parsed.artist;

    const pad = (n, len) => String(n).padStart(len, '0');
    const now = new Date();
    const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
    const hms = `${ymd}_${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;

    const map = {
      '{title}': cleanTitle,
      '{core}': cleanTitle,
      '{clean_title}': cleanTitle,
      '{artist}': artistName,
      '{channel}': channel,
      '{subtitle}': parsed.subtitle,
      '{episode}': parsed.episode !== null ? String(parsed.episode) : '',
      '{season}': parsed.season !== null ? String(parsed.season) : '',
      '{year}': parsed.year !== null ? String(parsed.year) : '',
      '{quality}': parsed.quality,
      '{group}': parsed.group,
      '{tags}': (parsed.tags || []).join(' '),
      '{index}': String(index),
      '{index3}': pad(index, 3),
      '{index4}': pad(index, 4),
      '{index5}': pad(index, 5),
      '{date}': ymd,
      '{datetime}': hms,
      '{original}': base,
      '{base}': base,
      '{ext}': ext,
      '{uploader}': String(meta.uploader || ''),
      '{platform}': String(meta.platform || ''),
      '{duration}': String(meta.duration || ''),
    };

    let result = tpl.replace(/\{\{index:(\d+)\}\}/g, (_, len) => pad(index, parseInt(len, 10)));
    // 容错：把 {{key}} 视为 {key}（避免手误写成双花括号导致占位符不生效）
    result = result.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, '{$1}');
    for (const [k, v] of Object.entries(map)) {
      result = result.split(k).join(v);
    }
    return result;
  }

  applyFieldLimit(base, ext, p) {
    const maxLen = parseInt(p.max_length || 0, 10);
    let newExt = ext;

    const allow = (p.allow_ext || '').trim();
    if (allow !== '' && ext !== '') {
      const list = allow.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (list.length && !list.includes(ext.toLowerCase())) {
        newExt = list[0];
      }
    }

    const block = (p.block_ext || '').trim();
    if (block !== '' && ext !== '') {
      const list = block.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (list.includes(ext.toLowerCase())) {
        newExt = '';
      }
    }

    let r = base;
    if (maxLen > 0) {
      const budget = Math.max(1, maxLen - (newExt !== '' ? mbLen(newExt) + 1 : 0));
      if (mbLen(r) > budget) {
        const trunc = p.truncate || 'end';
        if (trunc === 'middle') r = this.truncateMiddle(r, budget);
        else if (trunc === 'start') r = mbSubstr(r, mbLen(r) - budget);
        else r = mbSubstr(r, 0, budget);
        r = r.replace(/[ .\-_]+$/g, '');
      }
    }

    if (newExt !== ext) {
      return new ExtChange(r, newExt);
    }
    return r;
  }

  truncateMiddle(s, budget) {
    if (budget < 4) return mbSubstr(s, 0, Math.max(1, budget));
    const head = Math.ceil(budget * 0.6);
    const tail = budget - head - 1;
    return mbSubstr(s, 0, head) + '…' + mbSubstr(s, -tail);
  }

  applyDelete(base, p) {
    const mode = p.mode || 'literal';
    const ignore = !!p.ignore_case;
    const flags = ignore ? 'giu' : 'gu';

    let patterns = p.pattern || '';
    let list;
    if (mode === 'regex') {
      list = String(patterns).split(/\r\n|\r|\n/).map((x) => x.trim()).filter(Boolean);
    } else {
      list = String(patterns).split('|').map((x) => x.trim()).filter(Boolean);
    }

    let r = base;
    for (const pat of list) {
      if (pat === '') continue;
      if (mode === 'regex') {
        try {
          r = r.replace(new RegExp(pat, flags), '');
        } catch (e) { /* 非法正则跳过 */ }
      } else {
        // 字面量：转义后按"全部匹配"删除（忽略大小写时用 i 标志）
        const esc = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          r = r.replace(new RegExp(esc, flags), '');
        } catch (e) { /* 跳过 */ }
      }
    }

    r = r.replace(/\s{2,}/gu, ' ');
    r = r.replace(/^[ \t\-_.、,，]+|[ \t\-_.、,，]+$/g, '');
    if (r === '' && p.keep_if_empty) return base;
    return r;
  }

  applyAdd(base, p, ctx) {
    let r = base;
    const prefix = p.prefix || '';
    const suffix = p.suffix || '';

    if (prefix !== '') {
      if ((p.prefix_pos || 'before') === 'after') r = r + prefix;
      else r = prefix + r;
    }
    if (suffix !== '') {
      if ((p.suffix_pos || 'after') === 'before') r = suffix + r;
      else r = r + suffix;
    }

    if (p.number) {
      const start = parseInt(p.number_start || 1, 10);
      const pad = parseInt(p.number_pad || 3, 10);
      const sep = p.number_sep || '';
      const num = start + parseInt(ctx.index || 0, 10);
      const numStr = pad > 0 ? String(num).padStart(pad, '0') : String(num);
      if ((p.number_pos || 'prefix') === 'suffix') r = r + sep + numStr;
      else r = numStr + sep + r;
    }
    return r.trim();
  }

  applyReplace(base, p) {
    const find = p.find || '';
    if (find === '') return base;
    const repl = p.replace || '';
    const limit = p.all ? -1 : 1;

    if (p.regex) {
      const flags = 'u' + (p.ignore_case ? 'i' : '');
      try {
        return base.replace(new RegExp(find, flags), repl);
      } catch (e) {
        return base;
      }
    }
    if (p.ignore_case) {
      const flags = 'giu';
      try {
        return base.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), repl);
      } catch (e) {
        return base;
      }
    }
    // 普通字面量替换（带次数限制）
    if (limit === -1) return base.split(find).join(repl);
    let idx = base.indexOf(find);
    if (idx === -1) return base;
    return base.slice(0, idx) + repl + base.slice(idx + find.length);
  }

  applyCase(base, mode) {
    switch (mode) {
      case 'upper': return mbStrToUpper(base);
      case 'title': return mbTitleCase(base);
      case 'camel': {
        const spaced = base.replace(/_/g, ' ');
        const words = spaced.split(/\s+/).map((w) => w ? w[0].toLocaleUpperCase() + w.slice(1) : '');
        return words.join('').replace(/^./, (c) => c.toLocaleLowerCase());
      }
      case 'snake': return base.replace(/[\s\-]+/gu, '_');
      case 'kebab': return base.replace(/[\s_]+/gu, '-');
      default: return mbStrToLower(base);
    }
  }

  applySmart(base, p, ctx) {
    const source = ctx.title !== '' ? ctx.title : base;
    // 先做清洗分析：剥离视频 ID / format 后缀 / 标签段，抽出核心标题与频道
    const info = cleanName(source, {
      strip_emoji: !!p.strip_emoji,
      channel_as_artist: p.channel_as_artist !== false,
    });

    const tpl = (p.template || '').trim();
    let r;
    if (tpl === '') {
      r = composeName(info);
    } else {
      r = this.renderTemplate(tpl, base, '', ctx, info);
    }
    if (!r || r.trim() === '') {
      if (p.use_original_fallback) return base;
      return base;
    }
    return r.trim();
  }

  transliterate(s) {
    s = s.replace(/[^\p{L}\p{N}\s\-_.]/gu, '');
    s = s.replace(/\s+/gu, ' ');
    return s.trim();
  }

  normalizeRules(rules) {
    const out = [];
    for (const r of rules || []) {
      if (r.enabled === false) continue;
      const type = r.rule_type || '';
      if (!TYPES.includes(type)) continue;
      out.push({
        id: parseInt(r.id || 0, 10),
        rule_type: type,
        params: r.params || {},
        sort_order: parseInt(r.sort_order || 0, 10),
      });
    }
    out.sort((a, b) => a.sort_order - b.sort_order);
    return out;
  }

  /** 规则元信息，供前端渲染表单 */
  static schema() {
    return [
      { type: 'template', label: '模板生成', fields: [
        { name: 'template', label: '模板', type: 'text', default: '{artist} - {title}',
          help: '占位符: {title} {artist} {episode} {season} {year} {quality} {group} {index} {index3} {date} {original} {ext} {{index:4}}' },
      ]},
      { type: 'field_limit', label: '字段限制', fields: [
        { name: 'max_length', label: '最大长度(字符)', type: 'number', default: 100 },
        { name: 'truncate', label: '截断方式', type: 'select', default: 'end',
          options: { end: '截尾', middle: '截中', start: '截头' } },
        { name: 'allow_ext', label: '扩展名白名单(逗号分隔)', type: 'text', default: '' },
        { name: 'block_ext', label: '扩展名黑名单(逗号分隔)', type: 'text', default: '' },
      ]},
      { type: 's2t', label: '简体 → 繁体', fields: [] },
      { type: 't2s', label: '繁体 → 简体', fields: [] },
      { type: 'delete', label: '批量删除', fields: [
        { name: 'mode', label: '模式', type: 'select', default: 'literal',
          options: { literal: '字面量(用 | 分隔多个)', regex: '正则(每行一条)' } },
        { name: 'pattern', label: '要删除的内容', type: 'textarea', default: '' },
        { name: 'ignore_case', label: '忽略大小写', type: 'bool', default: false },
        { name: 'keep_if_empty', label: '删空时保留原名', type: 'bool', default: true },
      ]},
      { type: 'add', label: '批量增加', fields: [
        { name: 'prefix', label: '前缀', type: 'text', default: '' },
        { name: 'prefix_pos', label: '前缀位置', type: 'select', default: 'before',
          options: { before: '前', after: '后' } },
        { name: 'suffix', label: '后缀', type: 'text', default: '' },
        { name: 'suffix_pos', label: '后缀位置', type: 'select', default: 'after',
          options: { before: '前', after: '后' } },
        { name: 'number', label: '添加序号', type: 'bool', default: false },
        { name: 'number_pos', label: '序号位置', type: 'select', default: 'prefix',
          options: { prefix: '前', suffix: '后' } },
        { name: 'number_start', label: '起始序号', type: 'number', default: 1 },
        { name: 'number_pad', label: '序号位数(补零)', type: 'number', default: 3 },
        { name: 'number_sep', label: '序号分隔符', type: 'text', default: ' ' },
      ]},
      { type: 'replace', label: '查找替换', fields: [
        { name: 'find', label: '查找', type: 'text', default: '' },
        { name: 'replace', label: '替换为', type: 'text', default: '' },
        { name: 'regex', label: '使用正则', type: 'bool', default: false },
        { name: 'ignore_case', label: '忽略大小写', type: 'bool', default: false },
        { name: 'all', label: '替换全部', type: 'bool', default: true },
      ]},
      { type: 'case', label: '大小写', fields: [
        { name: 'mode', label: '模式', type: 'select', default: 'lower',
          options: { lower: '全小写', upper: '全大写', title: '首字母大写', camel: '驼峰', snake: '下划线', kebab: '中划线' } },
      ]},
      { type: 'trim', label: '去首尾', fields: [
        { name: 'chars', label: '要去除的字符', type: 'text', default: ' \t\n\r' },
        { name: 'mode', label: '位置', type: 'select', default: 'both',
          options: { both: '两端', left: '仅左', right: '仅右' } },
      ]},
      { type: 'sanitize', label: '非法字符清理', fields: [
        { name: 'replacement', label: '替换为', type: 'text', default: '_' },
        { name: 'collapse_space', label: '合并连续空白', type: 'bool', default: true },
      ]},
      { type: 'smart', label: '智能生成', fields: [
        { name: 'template', label: '模板（留空用默认「频道 - 核心标题」）', type: 'text', default: '',
          help: '可用占位符：{artist} {channel} {title} {core} {clean_title} {index3} {date} {original}；双花括号 {{title}} 也会被识别' },
        { name: 'strip_emoji', label: '去掉表情符号', type: 'bool', default: false },
        { name: 'channel_as_artist', label: '无作者时用频道名', type: 'bool', default: true },
        { name: 'use_original_fallback', label: '解析失败时用原名', type: 'bool', default: true },
      ]},
      { type: 'slug', label: 'URL 安全 slug', fields: [
        { name: 'max_length', label: '最大长度', type: 'number', default: 80 },
      ]},
      { type: 'transliterate', label: '去符号音译', fields: [] },
    ];
  }
}

module.exports = { RenameEngine, ExtChange, TYPES };
