import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let RULES;
if (args[0] === '--manifest') {
  if (!args[1]) throw new Error('Usage: node tools/build-court-rules.mjs --manifest <manifest.json>');
  RULES = JSON.parse(fs.readFileSync(args[1], 'utf8').replace(/^\ufeff/, ''));
} else if (args[0] === '--single') {
  if (!args[1] || !args[2]) {
    throw new Error('Usage: node tools/build-court-rules.mjs --single <slug> <input.txt>');
  }
  RULES = [{ slug: args[1], input: args[2] }];
} else {
  const [criminalInput, civilInput] = args;
  if (!criminalInput || !civilInput) {
    throw new Error('Usage: node tools/build-court-rules.mjs <criminal.txt> <civil.txt>');
  }
  RULES = [
    { slug: 'criminal-procedure', input: criminalInput },
    { slug: 'civil-procedure', input: civilInput },
  ];
}

const TAGS = {
  編: ['Part', 'PartTitle', 'TOCPart'],
  章: ['Chapter', 'ChapterTitle', 'TOCChapter'],
  節: ['Section', 'SectionTitle', 'TOCSection'],
  款: ['Subsection', 'SubsectionTitle', 'TOCSubsection'],
  目: ['Division', 'DivisionTitle', 'TOCDivision'],
};
const LEVELS = { 編: 1, 章: 2, 節: 3, 款: 4, 目: 5 };
const KANJI_DIGITS = new Map([['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]]);
const CIRCLED_DIGITS = Array.from('①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳');
const CIRCLED_NUMBER = new Map(CIRCLED_DIGITS.map((digit, index) => [digit, index + 1]));

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function kanjiToNumber(value) {
  const source = String(value || '').replace(/○/g, '〇').replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(source)) return Number(source);
  if (!/[十百千万]/.test(source) && /^[〇零一二三四五六七八九]+$/.test(source)) {
    return Number(Array.from(source, (char) => KANJI_DIGITS.get(char)).join(''));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of source) {
    if (KANJI_DIGITS.has(char)) {
      digit = KANJI_DIGITS.get(char);
    } else if (char === '十' || char === '百' || char === '千') {
      const unit = char === '十' ? 10 : char === '百' ? 100 : 1000;
      section += (digit || 1) * unit;
      digit = 0;
    } else if (char === '万') {
      total += (section + digit || 1) * 10000;
      section = 0;
      digit = 0;
    } else {
      return NaN;
    }
  }
  return total + section + digit;
}

function parseArticleNumber(value) {
  return String(value || '').split('の').map(kanjiToNumber).join('_');
}

function parseHeading(line) {
  const match = line.match(/^第[〇○零一二三四五六七八九十百千万0-9０-９]+(編|章|節|款|目)[　 ]*(.+?)(?:[　 ]*（(.+?)）)?$/);
  if (!match) return null;
  const [tag, titleTag, tocTag] = TAGS[match[1]];
  const title = line.replace(/[　 ]*（.+?）$/, '');
  return { tag, titleTag, tocTag, level: LEVELS[match[1]], title, range: match[3] || '' };
}

function isAmendmentNote(line) {
  return /^（(?:明治|大正|昭和|平成|令和|明|大|昭|平|令)[〇○零一二三四五六七八九十百千万0-9０-９]+.*(?:最裁規|最高裁判所規則)/.test(line);
}

function removePdfJapaneseSpacing(value) {
  const japanese = '\\u3005\\u3040-\\u30ff\\u3400-\\u9fff〇○零一二三四五六七八九十百千万０-９';
  const source = String(value || '');
  const marker = source.match(/^([0-9０-９]+|[一二三四五六七八九十百]+|[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス])([\t 　]+)(?![条項号編章節款目])(.+)$/);
  const body = marker ? marker[3] : source;
  const normalized = body
    .replace(new RegExp(`(?<=[${japanese}）)」』】〕、。，．])[\\t 　]+(?=[${japanese}（(「『【〔、。，．）)」』】〕])`, 'g'), '')
    .replace(/[\t 　]+(?=[、。，．）)」』】〕])/g, '')
    .replace(/(?<=[（(「『【〔、。，．])[\t 　]+/g, '');
  return marker ? `${marker[1]} ${normalized}` : normalized;
}

function coalescePdfWrappedLines(lines, { dropAmendmentNotes = false } = {}) {
  const structuralStart = new RegExp(
    '^(?:' +
      '第[〇○零一二三四五六七八九十百千万0-9０-９]+(?:編|章|節|款|目)|' +
      '附[　 ]*則(?:[（(]|[　 ]|$)|' +
      '（|' +
      '第[〇○零一二三四五六七八九十百千万0-9０-９]+条(?:の[〇○零一二三四五六七八九十百千万0-9０-９]+)?|' +
      '(?:別表|別紙|様式|付録)(?:[　 ]|第|$)|' +
      '[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][　 ]*|' +
      '[０-９0-9]+[　 ]+|' +
      '[一二三四五六七八九十百]+[　 ]+|' +
      '[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス][　 ]+' +
    ')'
  );
  const result = [];
  let current = '';
  let droppingNote = false;

  const flush = () => {
    if (current) result.push(current);
    current = '';
  };

  for (const rawLine of lines) {
    const line = removePdfJapaneseSpacing(String(rawLine || '').replace(/\f/g, '').trim());
    if (!line || line === '@@PAGE_BREAK@@') continue;
    if (droppingNote) {
      if (line.endsWith('）')) droppingNote = false;
      continue;
    }
    if (dropAmendmentNotes && isAmendmentNote(line)) {
      flush();
      droppingNote = !line.endsWith('）');
      continue;
    }
    if (/^附[　 ]*則(?:[（(].*[）)])?$/.test(line)) {
      flush();
      result.push(line);
      continue;
    }
    if (structuralStart.test(line)) flush();
    current += line;
  }
  flush();
  return result;
}

function node(tag, attrs = {}, children = []) {
  return { tag, attrs, children };
}

function textNode(tag, text) {
  return node(tag, {}, [String(text || '')]);
}

function serialize(item, indent = '') {
  if (typeof item === 'string') return `${indent}${escapeXml(item)}`;
  const attrs = Object.entries(item.attrs || {}).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  if (!item.children?.length) return `${indent}<${item.tag}${attrs}/>`;
  if (item.children.every((child) => typeof child === 'string')) {
    return `${indent}<${item.tag}${attrs}>${item.children.map(escapeXml).join('')}</${item.tag}>`;
  }
  const children = item.children.map((child) => serialize(child, `${indent}  `)).join('\n');
  return `${indent}<${item.tag}${attrs}>\n${children}\n${indent}</${item.tag}>`;
}

function createToc(lines) {
  const toc = node('TOC');
  const stack = [{ level: 0, item: toc }];
  for (const line of coalescePdfWrappedLines(lines)) {
    const heading = parseHeading(line);
    if (!heading) continue;
    while (stack.at(-1).level >= heading.level) stack.pop();
    const item = node(heading.tocTag, {}, [textNode(heading.titleTag, heading.title)]);
    if (heading.range) item.children.push(textNode('ArticleRange', heading.range));
    stack.at(-1).item.children.push(item);
    stack.push({ level: heading.level, item });
  }
  return toc;
}

function normalizeCircledParagraphs(root) {
  const visit = (item) => {
    if (typeof item === 'string') return;
    if (item.tag === 'Article') normalizeArticle(item);
    for (const child of item.children || []) visit(child);
  };

  const findSentences = (item, result = []) => {
    if (typeof item === 'string') return result;
    if (item.tag === 'Sentence') result.push(item);
    for (const child of item.children || []) findSentences(child, result);
    return result;
  };

  const makeParagraph = (number, sentence) => node('Paragraph', { Num: String(number) }, [
    textNode('ParagraphNum', number === 1 ? '' : String(number)),
    node('ParagraphSentence', {}, [textNode('Sentence', sentence.trimStart())]),
  ]);

  const normalizeArticle = (article) => {
    const paragraphs = article.children.filter((child) => child.tag === 'Paragraph');
    for (const paragraph of paragraphs) {
      for (const sentence of findSentences(paragraph)) {
        if (!sentence.children.every((child) => typeof child === 'string')) continue;
        const value = sentence.children.join('');
        const matches = [...value.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][\t 　]*/g)];
        if (!matches.length) continue;
        const numbers = matches.map((match) => CIRCLED_NUMBER.get(match[0][0]));
        const sequential = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
        const paragraphNumber = Number(paragraph.attrs.Num);
        const beginsWithOne = numbers[0] === 1 && value.slice(0, matches[0].index).trim() === '';
        const continuesParagraphs = numbers[0] === paragraphNumber + 1;
        if (!sequential || (!beginsWithOne && !continuesParagraphs)) continue;

        const segments = matches.map((match, index) => value.slice(
          match.index + match[0].length,
          matches[index + 1]?.index ?? value.length,
        ));
        const newParagraphs = [];
        if (beginsWithOne) {
          sentence.children = [segments.shift().trimStart()];
          numbers.shift();
        } else {
          sentence.children = [value.slice(0, matches[0].index).trimEnd()];
        }
        numbers.forEach((number, index) => newParagraphs.push(makeParagraph(number, segments[index])));
        const insertAt = article.children.indexOf(paragraph) + 1;
        article.children.splice(insertAt, 0, ...newParagraphs);
        break;
      }
    }
  };

  visit(root);
}

function createBody(lines, title) {
  const main = node('MainProvision');
  const stack = [{ level: 0, item: main }];
  let currentArticle = null;
  let currentParagraph = null;
  let currentItem = null;
  let pendingCaption = '';
  const seenArticleNumbers = new Set();
  const numberChars = '〇○零一二三四五六七八九十百千万0-9０-９';
  const articleLinePattern = new RegExp(`^第([${numberChars}]+)条(?:の([${numberChars}]+))?[　 ]*(.*)$`);

  const ensureFallbackArticle = () => {
    if (currentArticle && currentParagraph) return;
    currentArticle = node('Article', { Num: '1' }, [textNode('ArticleTitle', '')]);
    stack.at(-1).item.children.push(currentArticle);
    addParagraph(1, '');
  };

  const addParagraph = (number, sentence) => {
    const paragraph = node('Paragraph', { Num: String(number) }, [
      textNode('ParagraphNum', number === 1 ? '' : String(number)),
      node('ParagraphSentence', {}, [textNode('Sentence', sentence)]),
    ]);
    currentArticle.children.push(paragraph);
    currentParagraph = paragraph;
    currentItem = null;
  };

  const bodyLines = coalescePdfWrappedLines(lines, { dropAmendmentNotes: true });
  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex += 1) {
    const line = bodyLines[lineIndex];
    const heading = parseHeading(line);
    if (heading) {
      while (stack.at(-1).level >= heading.level) stack.pop();
      const item = node(heading.tag, {}, [textNode(heading.titleTag, heading.title)]);
      stack.at(-1).item.children.push(item);
      stack.push({ level: heading.level, item });
      currentArticle = null;
      currentParagraph = null;
      currentItem = null;
      pendingCaption = '';
      continue;
    }

    if (/^附[　 ]*則/.test(line)) {
      const item = node('SupplProvision', {}, [textNode('SupplProvisionLabel', line)]);
      main.children.push(item);
      stack.splice(1, stack.length - 1, { level: 1, item });
      seenArticleNumbers.clear();
      currentArticle = null;
      currentParagraph = null;
      currentItem = null;
      pendingCaption = '';
      continue;
    }

    if (/^（.+）$/.test(line)) {
      const nextArticleMatch = (bodyLines[lineIndex + 1] || '').match(articleLinePattern);
      const nextArticleNum = nextArticleMatch
        ? [nextArticleMatch[1], nextArticleMatch[2]].filter(Boolean).map(kanjiToNumber).join('_')
        : '';
      if (nextArticleNum && !seenArticleNumbers.has(nextArticleNum)) {
        pendingCaption = line;
      } else {
        const sentence = currentParagraph?.children.find((child) => child.tag === 'ParagraphSentence')?.children?.[0];
        if (sentence) sentence.children[0] += line;
      }
      continue;
    }

    const articleMatch = line.match(articleLinePattern);
    if (articleMatch) {
      const articleNum = [articleMatch[1], articleMatch[2]].filter(Boolean).map(kanjiToNumber).join('_');
      if (seenArticleNumbers.has(articleNum)) {
        const sentence = currentParagraph?.children.find((child) => child.tag === 'ParagraphSentence')?.children?.[0];
        if (sentence) sentence.children[0] += line;
        continue;
      }
      seenArticleNumbers.add(articleNum);
      currentArticle = node('Article', { Num: articleNum }, []);
      if (pendingCaption) currentArticle.children.push(textNode('ArticleCaption', pendingCaption));
      currentArticle.children.push(textNode('ArticleTitle', `第${articleMatch[1]}条${articleMatch[2] ? `の${articleMatch[2]}` : ''}`));
      stack.at(-1).item.children.push(currentArticle);
      pendingCaption = '';
      let articleSentence = articleMatch[3];
      const inlineCaption = articleSentence.match(/^[（(]([^）)]+)[）)](.*)$/);
      if (inlineCaption) {
        currentArticle.children.splice(currentArticle.children.length - 1, 0, textNode('ArticleCaption', `（${inlineCaption[1]}）`));
        articleSentence = inlineCaption[2];
      }
      addParagraph(1, articleSentence);
      continue;
    }

    const paragraphMatch = currentArticle && line.match(/^([０-９0-9]+)(.+)$/);
    if (paragraphMatch) {
      const paragraphNum = Number(paragraphMatch[1].replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)));
      addParagraph(paragraphNum, paragraphMatch[2]);
      continue;
    }

    const itemMatch = currentParagraph && line.match(/^([一二三四五六七八九十百]+)(.+)$/);
    if (itemMatch && Number.isFinite(kanjiToNumber(itemMatch[1])) && kanjiToNumber(itemMatch[1]) <= 100) {
      currentItem = node('Item', { Num: String(kanjiToNumber(itemMatch[1])) }, [
        textNode('ItemTitle', itemMatch[1]),
        node('ItemSentence', {}, [textNode('Sentence', itemMatch[2])]),
      ]);
      currentParagraph.children.push(currentItem);
      continue;
    }

    const subitemMatch = currentItem && line.match(/^([イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス])(.+)$/);
    if (subitemMatch) {
      currentItem.children.push(node('Subitem1', { Num: subitemMatch[1] }, [
        textNode('Subitem1Title', subitemMatch[1]),
        node('Subitem1Sentence', {}, [textNode('Sentence', subitemMatch[2])]),
      ]));
      continue;
    }

    if (line.trim()) {
      if (!currentParagraph) ensureFallbackArticle();
      const sentence = currentParagraph.children.find((child) => child.tag === 'ParagraphSentence')?.children?.[0];
      if (sentence) sentence.children[0] += line;
    }
  }
  normalizeCircledParagraphs(main);
  return main;
}

function convertRule(rule) {
  const raw = fs.readFileSync(rule.input, 'utf8').replace(/^\ufeff/, '');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines[0];
  const lawNum = lines[1];
  const markerIndex = lines.indexOf('@@BODY@@');
  let tocLines;
  let bodyLines;
  if (markerIndex >= 0) {
    tocLines = lines.slice(2, markerIndex);
    bodyLines = lines.slice(markerIndex + 1);
  } else {
    const tocStart = lines.findIndex((line, index) => index >= 2 && parseHeading(line));
    if (tocStart < 0) throw new Error(`Could not find the table of contents for ${title}`);
    const firstHeading = parseHeading(lines[tocStart]);
    const bodyStart = lines.findIndex((line, index) => index > tocStart && (
      parseHeading(line)?.tag === firstHeading.tag &&
      parseHeading(line)?.title === firstHeading.title
    ));
    if (bodyStart < 0) throw new Error(`Could not find the body start for ${title}`);
    tocLines = lines.slice(2, bodyStart);
    bodyLines = lines.slice(bodyStart);
  }
  const law = node('Law', { Era: '', Year: '', Num: '', LawType: 'Rule', Lang: 'ja' }, [
    textNode('LawNum', lawNum),
    node('LawBody', {}, [
      textNode('LawTitle', title),
      createToc(tocLines),
      createBody(bodyLines, title),
    ]),
  ]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(law)}\n`;
  const outputDir = path.resolve('data', 'court-rules');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${rule.slug}.xml`), xml);
  return `${title}: data/court-rules/${rule.slug}.xml`;
}

console.log(RULES.map(convertRule).join('\n'));
