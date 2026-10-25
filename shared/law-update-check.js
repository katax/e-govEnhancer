(function (global) {
  'use strict';
  const ORIGIN = 'https://laws.e-gov.go.jp';
  const BUTTON_LABEL = '法令ファイルの再取得';
  const UPDATE_LABEL = '法令に更新があります';
  const validLawId = value => typeof value === 'string' && /^[0-9A-Z]{15}$/.test(value);

  function isCurrentView(url, mode, lawId) {
    try {
      const parsed = new URL(url);
      if (!validLawId(lawId)) return false;
      if (mode === 'normal') return parsed.origin === ORIGIN
        && parsed.pathname.replace(/\/$/, '') === `/law/${lawId}`
        && !parsed.searchParams.has('occasion_date') && !parsed.searchParams.has('revisionId');
      return mode === 'lite' && parsed.pathname === '/viewer.html'
        && parsed.searchParams.get('lawId') === lawId
        && !parsed.searchParams.has('revisionId') && !parsed.searchParams.has('localRule');
    } catch (_) { return false; }
  }

  function isValidRevision(revision, mode, lawId) {
    if (typeof revision !== 'string') return false;
    return mode === 'normal' ? /^[0-9]{1,12}_[0-9]{1,6}$/.test(revision)
      : mode === 'lite' && validLawId(lawId)
        && new RegExp(`^${lawId}_[0-9]{8}_[0-9A-Z]{15}$`).test(revision);
  }

  function normalBodyRevision(request, lawId) {
    if (!request || !validLawId(lawId)) return '';
    try {
      const url = new URL(request.url);
      if (url.origin !== ORIGIN) return '';
      if (request.method === 'POST' && url.pathname === '/internal-api/SelectLawTextData.json') {
        const body = JSON.parse(request.body);
        if (body.law_id !== lawId) return '';
        const revision = `${body.law_data_id}_${body.subRevision}`;
        return isValidRevision(revision, 'normal', lawId) ? revision : '';
      }
      if (request.method === 'GET') {
        return url.pathname.match(new RegExp(`^/data/[A-Za-z]+/${lawId}/([0-9]{1,12}_[0-9]{1,6})/${lawId}_[0-9A-Z_]+_law\\.html$`))?.[1] || '';
      }
    } catch (_) {}
    return '';
  }

  function latestEnforcedRevision(revisions, mode, lawId, today) {
    if (!Array.isArray(revisions)) return '';
    const candidates = revisions.map(revision => {
      const normal = mode === 'normal';
      return {
        id: normal ? `${revision?.LawDataId}_${revision?.SubRevision}` : revision?.law_revision_id,
        date: normal ? revision?.EnforcementDate : revision?.amendment_enforcement_date,
        current: normal ? revision?.IsCurrentEnforcement === true : revision?.current_revision_status === 'CurrentEnforced',
        future: !normal && revision?.current_revision_status === 'UnEnforced',
      };
    }).filter(revision => isValidRevision(revision.id, mode, lawId) && !revision.future
      // A scheduled date alone is not proof that an amendment is in force.
      && (!revision.date || /^\d{4}-\d{2}-\d{2}$/.test(revision.date) && revision.date <= today)
      && (revision.current || !!revision.date));
    candidates.sort((a, b) => Number(b.current) - Number(a.current)
      || String(b.date || '').localeCompare(String(a.date || '')));
    return candidates[0]?.id || '';
  }

  function setButtonState(button, updated) {
    if (!button) return;
    button.classList.toggle('has-law-update', updated === true);
    button.title = updated === true ? UPDATE_LABEL : BUTTON_LABEL;
    button.setAttribute('aria-label', updated === true ? `${BUTTON_LABEL}：${UPDATE_LABEL}` : BUTTON_LABEL);
  }

  global.EgovLawUpdates = Object.freeze({ isCurrentView, isValidRevision, normalBodyRevision,
    latestEnforcedRevision, setButtonState, BUTTON_LABEL });
})(globalThis);
