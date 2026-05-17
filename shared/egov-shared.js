(function (global) {
  'use strict';

  const LAW_BASE_URL = 'https://laws.e-gov.go.jp';

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatLawNameHtml(name, mutedClassName = 'law-name-muted') {
    return escapeHtml(String(name || '')).replace(
      /\uFF08[^\uFF09]*\uFF09/g,
      (match) => `<span class="${mutedClassName}">${match}</span>`
    );
  }

  function buildLawUrl(lawId) {
    return `${LAW_BASE_URL}/law/${encodeURIComponent(lawId)}`;
  }

  function formatArticleNumber(article) {
    const [base, ...suffixes] = String(article || '').split('_').filter(Boolean);
    if (!base) return '';
    return `第${base}条${suffixes.map((suffix) => `の${suffix}`).join('')}`;
  }

  function formatProvisionNumber(parts, {
    isArticleLevel = false,
    omitSingleParagraphFirst = false,
  } = {}) {
    if (!parts?.article) return '';
    let text = formatArticleNumber(parts.article);
    if (
      parts.paragraph &&
      !isArticleLevel &&
      !(omitSingleParagraphFirst && parts.paragraph === '1' && !parts.item)
    ) {
      text += `第${parts.paragraph}項`;
    }
    if (parts.item) text += `第${parts.item}号`;
    return text;
  }

  function normalizeLawNameForCopy(name) {
    return String(name || '')
      .replace(/\s*（[^）]*第[^）]*号）\s*$/, '')
      .trim();
  }

  function buildProvisionCopyPayload({ lawName, numberLabel, bodyText = '', url = '' } = {}, mode = 'url') {
    if (mode === 'url') return url;
    const titleLine = `${normalizeLawNameForCopy(lawName)} ${numberLabel || ''}`.trim();
    if (mode === 'law-number-url') return `${titleLine}\n${url}`;
    if (mode === 'text-url') return `${titleLine}\n---\n${bodyText || ''}\n${url}`;
    return url;
  }

  function extractLaws(data) {
    if (Array.isArray(data?.laws)) return data.laws;
    if (Array.isArray(data?.data?.laws)) return data.data.laws;
    if (Array.isArray(data?.result)) return data.result;
    if (Array.isArray(data)) return data;
    if (data?.law_lists) {
      const lawList = data.law_lists;
      if (Array.isArray(lawList.law)) return lawList.law;
      if (lawList.law) return [lawList.law];
    }
    return [];
  }

  function getLawFields(law) {
    const info = law?.law_info || {};
    const rev = law?.current_revision_info || law?.revision_info || {};
    return {
      lawId: info.law_id || law?.law_id || law?.lawId || '',
      lawName: rev.law_title || rev.abbrev || law?.law_title || law?.law_name || law?.lawName || '(名称不明)',
      lawNum: info.law_num || law?.law_num || law?.lawNum || '',
      lawType: info.law_type || rev.law_type || law?.law_type || law?.lawType || '',
    };
  }

  async function searchLawsByTitle(query, { limit = 31 } = {}) {
    const url =
      `${LAW_BASE_URL}/api/2/laws?law_title=${encodeURIComponent(query)}` +
      `&limit=${encodeURIComponent(limit)}&response_format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return extractLaws(data);
  }

  global.EgovShared = Object.freeze({
    LAW_BASE_URL,
    buildLawUrl,
    buildProvisionCopyPayload,
    escapeHtml,
    extractLaws,
    formatArticleNumber,
    formatLawNameHtml,
    formatProvisionNumber,
    getLawFields,
    normalizeLawNameForCopy,
    searchLawsByTitle,
  });
})(globalThis);
