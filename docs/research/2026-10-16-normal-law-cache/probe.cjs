// Read-only investigation of the current source. Passing probes confirm existing
// behavior, including limitations; they do not certify correctness or performance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'shared/egov-shared.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'content-controller.js'), 'utf8');
function fn(text, name) {
  const normalStart = text.indexOf(`  function ${name}(`);
  const start = normalStart >= 0 ? normalStart : text.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, name);
  const closing = text.slice(start).match(/\n {2}\}\r?(?=\n|$)/);
  assert.ok(closing, name);
  return text.slice(start, start + closing.index + closing[0].length);
}
const checks = [];
function check(name, run) {
  const evidence = run();
  checks.push({ name, passed: true, evidence });
}
class Element {
  constructor(id = '') { this.id = id; }
  querySelector() { return null; }
}
check('definition keys lose supplementary scope', () => {
  const c = vm.createContext({});
  vm.runInContext(fn(source, 'parseProvisionPath') + fn(source, 'buildJumpHistoryKey')
    + fn(shared, 'parseProvisionHash'), c);
  const main = c.buildJumpHistoryKey(c.parseProvisionPath('Mp-At_2-Pr_1-It_3_2'));
  const supplement = c.buildJumpHistoryKey(c.parseProvisionPath('law-Sp_1-At_2-Pr_1-It_3_2'));
  assert.equal(main, supplement);
  assert.equal(c.parseProvisionHash('#law-Sp_1-At_2-Pr_1-It_3_2').scope, 'Sp_1');
  return { main, supplement, sharedParserScope: 'Sp_1' };
});
check('definition candidates combine equal article numbers across scopes', () => {
  const nodes = [new Element('Mp-At_2-Pr_1'), new Element('law-Sp_1-At_2-Pr_1')];
  const c = vm.createContext({ Element, collectProvisionLinkTargets: () => nodes });
  vm.runInContext(fn(source, 'parseProvisionPath') + fn(source, 'buildDefinitionCandidateCache'), c);
  const groups = c.buildDefinitionCandidateCache();
  assert.equal(groups.size, 1);
  assert.equal(groups.get('2').raw.length, 2);
  return { groups: groups.size, idsInGroup: groups.get('2').raw.map(e => e.id) };
});
check('definition signature does not identify changed text or href', () => {
  const articles = [{ id: 'Mp-At_1', text: 'before' }, { id: 'Mp-At_2', href: '#Mp-At_1' }];
  const c = vm.createContext({ getAllArticles: () => articles });
  vm.runInContext(fn(source, 'getDefinitionApplySignature'), c);
  const before = c.getDefinitionApplySignature();
  articles[0].text = 'after'; articles[1].href = '#Mp-At_2';
  const after = c.getDefinitionApplySignature();
  assert.equal(before, after);
  return { before, after };
});
check('article observer covers childList but not attributes or characterData', () => {
  let options;
  const c = vm.createContext({ Element, EgovApp: { runWhenIdle() {} },
    MutationObserver: class { observe(_root, value) { options = value; } },
  });
  vm.runInContext(controller, c);
  c.EgovContentController.observeArticleChanges({ root: new Element('provisionview') });
  assert.equal(options.childList, true);
  assert.equal(options.attributes, undefined);
  assert.equal(options.characterData, undefined);
  const ignored = c.EgovContentController.shouldInvalidateArticleCache([
    { target: new Element('Mp-At_1-Pr_1'), addedNodes: [], removedNodes: [] },
  ]);
  assert.equal(ignored, false);
  return { options, nestedTextOrHrefTriggersPredicate: ignored };
});
check('empty article list remains cached until explicit invalidation', () => {
  let nodes = [];
  const c = vm.createContext({ articleElementsCache: null,
    document: { querySelectorAll: () => nodes },
  });
  vm.runInContext(fn(source, 'getAllArticles'), c);
  assert.equal(c.getAllArticles().length, 0);
  nodes = [{ id: 'Mp-At_1', offsetParent: {} }];
  const afterDomAppears = c.getAllArticles().length;
  assert.equal(afterDomAppears, 0);
  c.articleElementsCache = null;
  assert.equal(c.getAllArticles().length, 1);
  return { afterDomAppears, afterInvalidation: 1,
    limitation: 'Integration has a separate invalidation observer; this probe isolates the getter.' };
});
check('restored bound attribute skips event registration', () => {
  let registrations = 0;
  const clickable = { classList: { add() {} }, dataset: { egovReferenceBound: 'true' },
    tabIndex: -1, addEventListener() { registrations++; } };
  const sourceMap = new WeakMap();
  const c = vm.createContext({ splitReferenceTargetKey: () => ({ scope: '' }) });
  vm.runInContext(fn(shared, 'configureReferenceClickable'), c);
  c.configureReferenceClickable({ clickable, className: 'ref', targetKey: '2',
    sources: [{}], sourceMap, isEnabled: () => true, showPopup() {} });
  assert.equal(registrations, 0);
  assert.equal(sourceMap.has(clickable), true);
  return { registrations, sourceMapRestored: sourceMap.has(clickable) };
});
check('internal source URLs omit selected revision context', () => {
  const c = vm.createContext({ buildLawUrl: id => `https://laws.e-gov.go.jp/law/${id}` });
  vm.runInContext(fn(shared, 'buildInternalReferenceSourceUrl'), c);
  const url = c.buildInternalReferenceSourceUrl('405AC0000000088', { article: '2', id: 'Mp-Ch_1-At_2-Pr_1' });
  assert.equal(url, 'https://laws.e-gov.go.jp/law/405AC0000000088#Mp-Ch_1-At_2-Pr_1');
  return { url, selectedRevisionIncluded: false };
});
(async () => {
  let release, extractions = 0, marks = 0;
  const c = vm.createContext({
    definitionApplyScheduled: true, definitionApplyNotify: false,
    defTooltipEnabled: true, definitionApplySignature: '',
    waitForArticles: () => new Promise(resolve => { release = resolve; }),
    getAllArticles: () => [{}], getDefinitionApplySignature: () => 'sig',
    document: { querySelector: () => null }, clearDefinitionTooltips() {},
    performance: { now: () => 0 }, console: { debug() {}, warn() {} },
    extractDefinitions: () => { extractions++; return new Map([['term', {}]]); },
    markDefinedTerms: () => { marks++; return 1; },
    showPageIndicator() {},
  });
  vm.runInContext(fn(source, 'applyDefinitionTooltips'), c);
  const pending = c.applyDefinitionTooltips();
  c.defTooltipEnabled = false;
  release(true);
  await pending;
  assert.equal(extractions, 1);
  assert.equal(marks, 1);
  checks.push({ name: 'disabling definitions during article wait does not cancel resumed work',
    passed: true, evidence: { enabledAfterWait: c.defTooltipEnabled, extractions, marks } });
  process.stdout.write(JSON.stringify({ note: 'Isolated source probes with minimal stubs; no browser DOM or timing claims.', checks }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
