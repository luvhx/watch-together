import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeSubtitleBuffer,
  detectSubtitleFormat,
  parseAss,
  parseAssColor,
  parseAssDialogueText,
  parseSubtitleText,
  parseVtt,
  parseSrt,
  SubtitleParseError,
} from '../public/subtitles.js';

const ASS_SAMPLE = `[Script Info]
Title: 测试字幕
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans SC,54,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,{\\an8\\pos(960,80)\\c&H00FF00&\\b1}上方{\\i1}斜体{\\i0}\\N第二行
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,不应出现
`;

test('ASS 解析保留样式、定位和行内标签', () => {
  const ass = parseAss(ASS_SAMPLE);
  assert.equal(ass.playResX, 1920);
  assert.equal(ass.playResY, 1080);
  assert.equal(ass.events.length, 1);

  const cue = ass.events[0];
  assert.equal(cue.start, 1);
  assert.equal(cue.end, 4.5);
  assert.equal(cue.alignment, 8);
  assert.deepEqual(cue.position, { x: 960, y: 80 });
  assert.equal(cue.marginL, 60);
  assert.equal(cue.marginR, 60);
  assert.equal(cue.marginV, 48);
  assert.equal(cue.runs[0].text, '上方');
  assert.deepEqual(cue.runs[0].style.primary, { r: 0, g: 255, b: 0, a: 1 });
  assert.equal(cue.runs[0].style.bold, true);
  assert.equal(cue.runs[1].text, '斜体');
  assert.equal(cue.runs[1].style.italic, true);
  assert.equal(cue.runs[2].text, '\n');
  assert.equal(cue.runs[3].text, '第二行');
  assert.equal(cue.runs[3].style.italic, false);
  assert.equal(cue.runs[0].style.fontSize, 54);
  assert.equal(cue.runs[0].style.outline.r, 16);
  assert.ok(Math.abs(cue.runs[0].style.back.a - 0.498) < 0.01);
});

test('ASS 颜色与 CSS 渲染方向一致（BGR + 透明度）', () => {
  assert.deepEqual(parseAssColor('&H0000FF&'), {
    r: 255,
    g: 0,
    b: 0,
    a: 1,
  });
  assert.deepEqual(parseAssColor('&H00FF0000&'), {
    r: 0,
    g: 0,
    b: 255,
    a: 1,
  });
  const translucent = parseAssColor('&H80000000&');
  assert.equal(translucent.r, 0);
  assert.ok(Math.abs(translucent.a - 0.498) < 0.01);
  assert.deepEqual(parseAssColor('not-a-color', { r: 1, g: 2, b: 3, a: 1 }), {
    r: 1,
    g: 2,
    b: 3,
    a: 1,
  });
});

test('ASS 行内样式可以重置并覆盖字号、描边、透明度', () => {
  const base = {
    name: 'Default',
    fontName: 'Arial',
    fontSize: 40,
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
    marginL: 10,
    marginR: 10,
    marginV: 10,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
  };
  const parsed = parseAssDialogueText(
    '{\\fs60\\bord4\\alpha&H80&\\an5}A{\\r}B',
    base,
  );
  assert.equal(parsed.alignment, 5);
  assert.equal(parsed.runs[0].text, 'A');
  assert.equal(parsed.runs[0].style.fontSize, 60);
  assert.equal(parsed.runs[0].style.outlineWidth, 4);
  assert.ok(Math.abs(parsed.runs[0].style.primary.a - 0.498) < 0.01);
  assert.equal(parsed.runs[1].text, 'B');
  assert.equal(parsed.runs[1].style.fontSize, 40);
  assert.equal(parsed.runs[1].style.outlineWidth, 2);
  assert.equal(parsed.runs[1].style.primary.a, 1);
});

test('WebVTT 与 SRT 可以解析时间、实体和标签', () => {
  const vtt = `WEBVTT

NOTE 注释
不应出现

cue-1
00:00:01.200 --> 00:00:03.400 align:start
<v 小林>你好 &amp; 欢迎</v>

00:04.000 --> 00:06.000
第二句<cm></cm>
`;
  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.2);
  assert.equal(cues[0].end, 3.4);
  assert.equal(cues[0].text, '你好 & 欢迎');
  assert.equal(cues[1].text, '第二句');

  const srt = `1
00:00:00,500 --> 00:00:02,000
<i>第一行</i>

2
00:00:03,000 --> 00:00:04,000
第二行
`;
  const srtCues = parseSrt(srt);
  assert.equal(srtCues.length, 2);
  assert.equal(srtCues[0].start, 0.5);
  assert.equal(srtCues[0].text, '第一行');
  assert.equal(detectSubtitleFormat(vtt), 'vtt');
  assert.equal(detectSubtitleFormat(srt), 'srt');
});

test('没有 Script Info 的 ASS 片段也能识别', () => {
  const fragment = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,没有 Script Info\n`;
  assert.equal(detectSubtitleFormat(fragment), 'ass');
  const parsed = parseSubtitleText(fragment);
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].runs[0].text, '没有 Script Info');
});

test('统一入口可识别格式并拒绝空内容', () => {
  const parsed = parseSubtitleText(ASS_SAMPLE, {
    url: 'https://cdn.example.com/movie.ass',
  });
  assert.equal(parsed.format, 'ass');
  assert.equal(parsed.label, 'movie');
  assert.throws(() => parseSubtitleText('hello world'), SubtitleParseError);
  assert.throws(() => parseSubtitleText('WEBVTT\n\n'), /字幕/);
});

test('字幕解码支持 UTF-8 与 UTF-16 BOM', () => {
  const utf8 = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n');
  assert.match(decodeSubtitleBuffer(utf8), /你好/);

  const utf16 = Buffer.from('\uFEFFWEBVTT\n\n00:00.000 --> 00:01.000\n再见\n', 'utf16le');
  assert.match(decodeSubtitleBuffer(utf16), /再见/);
  assert.equal(detectSubtitleFormat(decodeSubtitleBuffer(utf16)), 'vtt');
});
