/**
 * 字幕解析器（无 DOM 依赖，可在浏览器和 node:test 中共用）。
 *
 * 支持：
 * - WebVTT
 * - SRT
 * - ASS / SSA：保留常用样式（字体、字号、颜色、描边、阴影、对齐、定位、边距、粗斜体等）
 *
 * ASS 不是 HTML 原生字幕格式，因此这里只负责把脚本解析成带样式快照的文本片段，
 * 由前端叠加层渲染，从而保留比 <track> 更完整的 ASS 视觉效果。
 */

export class SubtitleParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SubtitleParseError';
    this.code = 'SUBTITLE_PARSE_ERROR';
  }
}

function normalizeText(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function decodeSubtitleBuffer(buffer) {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) throw new SubtitleParseError('字幕文件是空的');

  const encodings = [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encodings.push('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encodings.push('utf-16be');
  encodings.push('utf-8', 'gb18030', 'big5');

  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      return normalizeText(decoder.decode(bytes));
    } catch {
      // 换下一种编码继续尝试。
    }
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  return normalizeText(text);
}

function looksLikeAss(text) {
  return /\[Script Info\]/i.test(text) && /\[Events\]/i.test(text);
}

export function detectSubtitleFormat(text) {
  const content = normalizeText(text).trimStart();
  if (!content) throw new SubtitleParseError('字幕文件是空的');
  if (looksLikeAss(content)) return 'ass';
  if (/\[Events\]/i.test(content) && /^\s*Dialogue:/im.test(content)) {
    return 'ass';
  }
  if (/^WEBVTT\b/i.test(content)) return 'vtt';
  if (/^\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/m.test(content)) return 'srt';
  if (/-->/.test(content)) return 'srt';
  throw new SubtitleParseError('无法识别字幕格式，请使用 ASS/SSA、WebVTT 或 SRT');
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function cleanCueText(raw) {
  return decodeEntities(
    raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, ''),
  )
    .replace(/\u00a0/g, ' ')
    .trim();
}

function parseClock(value) {
  const match = String(value)
    .trim()
    .match(/^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseTimingLine(line) {
  const [startPart, endPart] = line.split('-->');
  if (!startPart || !endPart) return null;
  const start = parseClock(startPart.trim().split(/\s+/)[0]);
  const end = parseClock(endPart.trim().split(/\s+/)[0]);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function sortCues(cues) {
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function parseVtt(text) {
  const lines = normalizeText(text).split('\n');
  const cues = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^WEBVTT\b/i.test(line.trim())) {
      index += 1;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)\b/i.test(line.trim())) {
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }

    const block = [];
    while (index < lines.length && lines[index].trim()) {
      block.push(lines[index]);
      index += 1;
    }
    const arrowIndex = block.findIndex((item) => item.includes('-->'));
    if (arrowIndex < 0) continue;
    const timing = parseTimingLine(block[arrowIndex]);
    if (!timing) continue;
    const cueText = cleanCueText(block.slice(arrowIndex + 1).join('\n'));
    if (!cueText) continue;
    cues.push({
      id: cues.length + 1,
      start: timing.start,
      end: timing.end,
      text: cueText,
    });
  }

  return sortCues(cues);
}

export function parseSrt(text) {
  const blocks = normalizeText(text).split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim());
    if (lines.length < 2) continue;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = parseTimingLine(lines[timingIndex]);
    if (!timing) continue;
    const cueText = cleanCueText(lines.slice(timingIndex + 1).join('\n'));
    if (!cueText) continue;
    cues.push({
      id: cues.length + 1,
      start: timing.start,
      end: timing.end,
      text: cueText,
    });
  }

  return sortCues(cues);
}

function parseAssTime(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/);
  if (!match) return null;
  const fraction = match[4].length === 3
    ? Number(`0.${match[4]}`)
    : Number(`0.${match[4].padEnd(2, '0')}`);
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    fraction
  );
}

function splitAssFields(value, count) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < value.length && fields.length < count - 1; index += 1) {
    if (value[index] === ',') {
      fields.push(value.slice(start, index));
      start = index + 1;
    }
  }
  fields.push(value.slice(start));
  return fields;
}

/**
 * ASS 颜色格式为 &HAABBGGRR：前两位是透明度（00 为不透明），
 * 后面依次是蓝、绿、红。
 */
export function parseAssColor(value, fallback = { r: 255, g: 255, b: 255, a: 1 }) {
  if (typeof value !== 'string' || !value.trim()) return { ...fallback };
  let raw = value.trim();
  let hex = '';

  if (/^&-?h/i.test(raw) || /^&h/i.test(raw) || /^h/i.test(raw)) {
    hex = raw.replace(/^&?h/i, '').replace(/&$/, '');
  } else if (/^-?\d+$/.test(raw)) {
    hex = (Number(raw) >>> 0).toString(16);
  } else if (/^#?[0-9a-f]{6,8}$/i.test(raw)) {
    hex = raw.replace(/^#/, '');
  } else {
    return { ...fallback };
  }

  if (!/^[0-9a-f]+$/i.test(hex)) return { ...fallback };
  hex = hex.padStart(8, '0').slice(-8);
  const alphaByte = Number.parseInt(hex.slice(0, 2), 16);
  return {
    r: Number.parseInt(hex.slice(6, 8), 16),
    g: Number.parseInt(hex.slice(4, 6), 16),
    b: Number.parseInt(hex.slice(2, 4), 16),
    a: 1 - alphaByte / 255,
  };
}

function parseAssAlpha(value, fallback = 0) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^&?h/i, '')
    .replace(/&$/, '');
  if (!raw) return fallback;
  // ASS 的透明度参数是十六进制，例如 &H80& 表示 50% 透明。
  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 255) : fallback;
}

function assFlag(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'string' && /^(true|yes)$/i.test(value.trim())) return true;
  return Number(value) !== 0;
}

function cloneColor(color) {
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: color.a,
  };
}

function cloneStyle(style) {
  return {
    ...style,
    primary: cloneColor(style.primary),
    secondary: cloneColor(style.secondary),
    outline: cloneColor(style.outline),
    back: cloneColor(style.back),
  };
}

const DEFAULT_STYLE = {
  name: 'Default',
  fontName: 'Arial',
  fontSize: 48,
  primary: { r: 255, g: 255, b: 255, a: 1 },
  secondary: { r: 255, g: 255, b: 0, a: 1 },
  outline: { r: 0, g: 0, b: 0, a: 1 },
  back: { r: 0, g: 0, b: 0, a: 1 },
  bold: false,
  italic: false,
  underline: false,
  strikeOut: false,
  borderStyle: 1,
  outlineWidth: 2,
  shadow: 1,
  alignment: 2,
  marginL: 40,
  marginR: 40,
  marginV: 32,
  scaleX: 100,
  scaleY: 100,
  spacing: 0,
  angle: 0,
};

function mapStyleFields(values, format) {
  const map = new Map();
  format.forEach((field, index) => {
    const key = field.trim().toLowerCase();
    const value = values[index] ?? '';
    map.set(key, key === 'text' ? value : value.trim());
  });
  return map;
}

function styleFromFields(fields) {
  const style = cloneStyle(DEFAULT_STYLE);
  style.name = fields.get('name') || 'Default';
  style.fontName = fields.get('fontname') || style.fontName;
  style.fontSize = numberOr(fields.get('fontsize'), style.fontSize);
  style.primary = parseAssColor(fields.get('primarycolour'), style.primary);
  style.secondary = parseAssColor(fields.get('secondarycolour'), style.secondary);
  style.outline = parseAssColor(
    fields.get('outlinecolour') ?? fields.get('tertiarycolour'),
    style.outline,
  );
  style.back = parseAssColor(fields.get('backcolour'), style.back);
  style.bold = assFlag(fields.get('bold'));
  style.italic = assFlag(fields.get('italic'));
  style.underline = assFlag(fields.get('underline'));
  style.strikeOut = assFlag(fields.get('strikeout'));
  style.borderStyle = clamp(
    Math.trunc(numberOr(fields.get('borderstyle'), style.borderStyle)),
    1,
    3,
  );
  style.outlineWidth = Math.max(0, numberOr(fields.get('outline'), style.outlineWidth));
  style.shadow = Math.max(0, numberOr(fields.get('shadow'), style.shadow));
  style.alignment = clamp(
    Math.trunc(numberOr(fields.get('alignment'), style.alignment)),
    1,
    9,
  );
  style.marginL = Math.max(0, numberOr(fields.get('marginl'), style.marginL));
  style.marginR = Math.max(0, numberOr(fields.get('marginr'), style.marginR));
  style.marginV = Math.max(0, numberOr(fields.get('marginv'), style.marginV));
  style.scaleX = numberOr(fields.get('scalex'), style.scaleX);
  style.scaleY = numberOr(fields.get('scaley'), style.scaleY);
  style.spacing = numberOr(fields.get('spacing'), style.spacing);
  style.angle = numberOr(fields.get('angle'), style.angle);
  return style;
}

function parsePositionValues(value, count = 2) {
  const numbers = String(value ?? '').match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length < count) return null;
  return numbers.slice(0, count).map(Number);
}

function applyAssTags(block, state) {
  const tagPattern = /\\([0-9]*[a-z]+)([^\\}]*)/gi;
  let match;
  while ((match = tagPattern.exec(block))) {
    const name = match[1].toLowerCase();
    const argument = match[2].trim();
    switch (name) {
      case 'an': {
        const alignment = Number.parseInt(argument, 10);
        if (alignment >= 1 && alignment <= 9) state.layout.alignment = alignment;
        break;
      }
      case 'pos': {
        const position = parsePositionValues(argument, 2);
        if (position) state.layout.position = { x: position[0], y: position[1] };
        break;
      }
      case 'move': {
        const position = parsePositionValues(argument, 4);
        if (position) {
          state.layout.position = { x: position[0], y: position[1] };
          state.layout.move = {
            x1: position[0],
            y1: position[1],
            x2: position[2],
            y2: position[3],
          };
        }
        break;
      }
      case 'fs': {
        const value = Number.parseFloat(argument);
        if (Number.isFinite(value)) {
          state.style.fontSize = argument.startsWith('+') || argument.startsWith('-')
            ? Math.max(1, state.style.fontSize + value)
            : Math.max(1, value);
        }
        break;
      }
      case 'fn':
        if (argument) state.style.fontName = argument;
        break;
      case 'b':
        state.style.bold =
          argument === '' ? true : Number.parseFloat(argument) !== 0;
        break;
      case 'i':
        state.style.italic = argument === '' || Number.parseFloat(argument) !== 0;
        break;
      case 'u':
        state.style.underline = argument === '' || Number.parseFloat(argument) !== 0;
        break;
      case 's':
        state.style.strikeOut = argument === '' || Number.parseFloat(argument) !== 0;
        break;
      case 'c':
      case '1c':
        state.style.primary = parseAssColor(argument, state.style.primary);
        break;
      case '2c':
        state.style.secondary = parseAssColor(argument, state.style.secondary);
        break;
      case '3c':
        state.style.outline = parseAssColor(argument, state.style.outline);
        break;
      case '4c':
        state.style.back = parseAssColor(argument, state.style.back);
        break;
      case 'alpha': {
        const alpha = 1 - parseAssAlpha(argument) / 255;
        state.style.primary.a = alpha;
        state.style.secondary.a = alpha;
        state.style.outline.a = alpha;
        state.style.back.a = alpha;
        break;
      }
      case '1a':
        state.style.primary.a = 1 - parseAssAlpha(argument, 0) / 255;
        break;
      case '2a':
        state.style.secondary.a = 1 - parseAssAlpha(argument, 0) / 255;
        break;
      case '3a':
        state.style.outline.a = 1 - parseAssAlpha(argument, 0) / 255;
        break;
      case '4a':
        state.style.back.a = 1 - parseAssAlpha(argument, 0) / 255;
        break;
      case 'bord':
        state.style.outlineWidth = Math.max(
          0,
          numberOr(argument, state.style.outlineWidth),
        );
        break;
      case 'shad':
        state.style.shadow = Math.max(0, numberOr(argument, state.style.shadow));
        break;
      case 'fsp':
        state.style.spacing = numberOr(argument, state.style.spacing);
        break;
      case 'fscx':
        state.style.scaleX = numberOr(argument, state.style.scaleX);
        break;
      case 'fscy':
        state.style.scaleY = numberOr(argument, state.style.scaleY);
        break;
      case 'fr':
        state.style.angle = numberOr(argument, state.style.angle);
        break;
      case 'r': {
        const reset = argument ? state.styles.get(argument.toLowerCase()) : null;
        state.style = cloneStyle(reset || state.baseStyle);
        if (reset) state.layout.alignment = reset.alignment;
        break;
      }
      case 'p':
        state.drawing = Number.parseInt(argument || '0', 10) > 0;
        break;
      default:
        // 未实现的 ASS 标签直接忽略，不把原始控制码显示给用户。
        break;
    }
  }
}

/**
 * 把一段 ASS Dialogue 文本解析成带样式快照的 run 列表。
 * 位置、对齐、边距等布局信息与 run 分开返回。
 */
export function parseAssDialogueText(rawText, baseStyle, styles = new Map(), margins = {}) {
  const base = cloneStyle(baseStyle || DEFAULT_STYLE);
  const state = {
    style: cloneStyle(base),
    baseStyle: base,
    styles,
    layout: {
      alignment: base.alignment,
      position: null,
      move: null,
      marginL: Math.max(0, numberOr(margins.marginL, base.marginL)),
      marginR: Math.max(0, numberOr(margins.marginR, base.marginR)),
      marginV: Math.max(0, numberOr(margins.marginV, base.marginV)),
    },
    drawing: false,
  };
  const runs = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    if (!state.drawing) {
      runs.push({ text: buffer, style: cloneStyle(state.style) });
    }
    buffer = '';
  };

  let index = 0;
  while (index < rawText.length) {
    const character = rawText[index];
    if (character === '{') {
      flush();
      const end = rawText.indexOf('}', index + 1);
      if (end < 0) {
        index += 1;
        continue;
      }
      applyAssTags(rawText.slice(index + 1, end), state);
      index = end + 1;
      continue;
    }
    if (character === '\\' && index + 1 < rawText.length) {
      const next = rawText[index + 1];
      if (next === 'N' || next === 'n') {
        flush();
        runs.push({ text: '\n', style: cloneStyle(state.style) });
        index += 2;
        continue;
      }
      if (next === 'h') {
        buffer += '\u00a0';
        index += 2;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();

  return {
    runs,
    alignment: state.layout.alignment,
    position: state.layout.position,
    move: state.layout.move,
    marginL: state.layout.marginL,
    marginR: state.layout.marginR,
    marginV: state.layout.marginV,
  };
}

export function parseAss(text) {
  const lines = normalizeText(text).split('\n');
  const sections = new Map();
  let section = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      if (!sections.has(section)) sections.set(section, []);
      continue;
    }
    if (section) sections.get(section).push(line);
  }

  const info = new Map();
  for (const line of sections.get('script info') ?? []) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    info.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }

  let playResX = numberOr(info.get('playresx'), 0);
  let playResY = numberOr(info.get('playresy'), 0);
  if (playResX > 0 && playResY <= 0) playResY = (playResX * 9) / 16;
  if (playResY > 0 && playResX <= 0) playResX = (playResY * 16) / 9;
  if (playResX <= 0 || playResY <= 0) {
    playResX = 1920;
    playResY = 1080;
  }

  const styleLines =
    sections.get('v4+ styles') ?? sections.get('v4 styles') ?? [];
  const styles = new Map();
  let styleFormat = null;
  for (const line of styleLines) {
    const trimmed = line.trim();
    if (/^Format:/i.test(trimmed)) {
      styleFormat = splitAssFields(trimmed.slice(trimmed.indexOf(':') + 1), 64).map(
        (field) => field.trim(),
      );
      continue;
    }
    if (!/^Style:/i.test(trimmed) || !styleFormat) continue;
    const values = splitAssFields(
      trimmed.slice(trimmed.indexOf(':') + 1),
      styleFormat.length,
    );
    const style = styleFromFields(mapStyleFields(values, styleFormat));
    styles.set(style.name.toLowerCase(), style);
  }

  if (!styles.has('default')) styles.set('default', cloneStyle(DEFAULT_STYLE));

  const eventLines = sections.get('events') ?? [];
  let eventFormat = null;
  const events = [];
  let eventId = 0;

  for (const line of eventLines) {
    const trimmed = line.trim();
    if (/^Format:/i.test(trimmed)) {
      eventFormat = splitAssFields(trimmed.slice(trimmed.indexOf(':') + 1), 64).map(
        (field) => field.trim(),
      );
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed) || !eventFormat) continue;
    const values = splitAssFields(
      trimmed.slice(trimmed.indexOf(':') + 1),
      eventFormat.length,
    );
    const fields = mapStyleFields(values, eventFormat);
    const start = parseAssTime(fields.get('start'));
    const end = parseAssTime(fields.get('end'));
    if (start === null || end === null || end <= start) continue;
    const rawText = fields.get('text') ?? '';
    if (!rawText.trim()) continue;

    const styleName = (fields.get('style') || 'Default').trim().toLowerCase();
    const baseStyle = styles.get(styleName) ?? styles.get('default');
    const eventMargins = {};
    for (const key of ['marginL', 'marginR', 'marginV']) {
      const value = numberOr(fields.get(key.toLowerCase()), 0);
      if (value > 0) eventMargins[key] = value;
    }
    const parsed = parseAssDialogueText(rawText, baseStyle, styles, eventMargins);

    events.push({
      id: ++eventId,
      start,
      end,
      layer: numberOr(fields.get('layer'), 0),
      styleName: baseStyle.name,
      text: rawText,
      runs: parsed.runs,
      alignment: parsed.alignment,
      position: parsed.position,
      move: parsed.move,
      marginL: parsed.marginL,
      marginR: parsed.marginR,
      marginV: parsed.marginV,
    });
  }

  if (events.length === 0) {
    throw new SubtitleParseError('ASS 文件中没有可用的 Dialogue 字幕');
  }

  events.sort((a, b) => a.start - b.start || a.layer - b.layer || a.id - b.id);

  return {
    playResX,
    playResY,
    styles: Object.fromEntries(styles),
    events,
  };
}

export function parseSubtitleText(text, { url = '' } = {}) {
  const format = detectSubtitleFormat(text);
  let cues = [];
  let ass = null;

  if (format === 'ass') {
    ass = parseAss(text);
    cues = ass.events;
  } else if (format === 'vtt') {
    cues = parseVtt(text);
  } else {
    cues = parseSrt(text);
  }

  if (cues.length === 0) {
    throw new SubtitleParseError(
      `未能从${url ? ` ${url}` : ''} 字幕文件中读取到字幕条目`,
    );
  }

  return {
    format,
    cues,
    ass,
    label: url ? subtitleLabelFromUrl(url) : '外部字幕',
  };
}

export function subtitleLabelFromUrl(url) {
  try {
    const parsed = new URL(url);
    let name = parsed.pathname.split('/').filter(Boolean).pop() || '';
    try {
      name = decodeURIComponent(name);
    } catch {
      // 保留原始文件名。
    }
    name = name.replace(/\.(ass|ssa|vtt|srt|webvtt)$/i, '');
    if (!name) name = parsed.hostname;
    return Array.from(name).slice(0, 36).join('');
  } catch {
    return '外部字幕';
  }
}
