// Adapter for normal-mode cache bodies. It never downloads or stores Lite data.
(() => {
  function cleanHtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed,form,base,link,meta').forEach(node=>node.remove());
    doc.querySelectorAll('*').forEach(node=>{
      for(const attr of [...node.attributes]) if(/^on/i.test(attr.name)||['style','src','srcset','srcdoc','action'].includes(attr.name))node.removeAttribute(attr.name);
      if(node.hasAttribute('href')) {
        try { const url=new URL(node.getAttribute('href'),'https://laws.e-gov.go.jp');
          if(!['http:','https:'].includes(url.protocol))node.removeAttribute('href');
          else if(!node.getAttribute('href').startsWith('#'))node.setAttribute('href',url.href);
        } catch (_) {node.removeAttribute('href');}
      }
    });
    return doc;
  }
  function xml(record) {
    const rows=JSON.parse(record.text).result?.searchResult_array;
    if(!Array.isArray(rows)||!rows.length)throw new Error('保存済み本文の形式を読み取れませんでした');
    const doc=document.implementation.createDocument(null,'Law');
    const make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const law=doc.documentElement;law.append(make('LawNum',record.lawData?.LawNum||''));
    const body=make('LawBody');law.append(body);body.append(make('LawTitle',record.lawData?.LawTitle||record.lawId));
    const main=make('MainProvision');body.append(main);
    function append(parent,value) {
      if(value===null||value===undefined)return;
      if(Array.isArray(value)){value.forEach(x=>append(parent,x));return;}
      if(typeof value!=='object'){parent.append(doc.createTextNode(String(value)));return;}
      for(const [key,child]of Object.entries(value)) {
        if(key==='#childs'){append(parent,child);continue;}
        if(key==='#text'){
          const text=String(child);
          parent.append(doc.createTextNode(/[<&]/.test(text) ? cleanHtml(text).body.textContent : text));
          continue;
        }
        if(key.startsWith('-')){if(['-Num','-Type','-AmendLawNum','-Extract','-WritingMode'].includes(key))parent.setAttribute(key.slice(1),String(child));continue;}
        if(!/^[A-Za-z][A-Za-z0-9]*$/.test(key))continue;
        for(const entry of Array.isArray(child)?child:[child]){const node=make(key);append(node,entry);parent.append(node);}
      }
    }
    for(const row of rows){
      if(!row.Content||!/^[A-Za-z][A-Za-z0-9]*$/.test(row.Type))continue;
      const supplementary=/SupplProvision$/.test(row.Type);
      const node=make(supplementary?'SupplProvision':row.Type);append(node,row.Content);
      (supplementary?body:main).append(node);
    }
    return new XMLSerializer().serializeToString(doc);
  }
  function html(record,root) {
    const doc=cleanHtml(record.text);
    const title=doc.getElementById('lawTitle')?.textContent||record.lawData?.LawTitle||record.lawId;
    const lawNum=doc.getElementById('lawTitleNo')?.textContent||record.lawData?.LawNum||'';
    const articles=[...doc.querySelectorAll('section.Article')];
    if(!articles.length)throw new Error('保存済みHTMLに法令本文がありません');
    doc.getElementById('lawTitle')?.remove();doc.getElementById('lawTitleNo')?.remove();
    doc.getElementById('TOC')?.remove();
    for(const article of articles){
      article.classList.add('law-article');
      const parts=globalThis.EgovShared.parseProvisionHash('#'+article.id);
      if(parts)article.dataset.articleNum=parts.article.replaceAll('_','-');
      if(parts?.scope)article.dataset.referenceScope=parts.scope;
      article.querySelectorAll('[id]').forEach(node=>{
        const p=globalThis.EgovShared.parseProvisionHash('#'+node.id);if(!p)return;
        if(p.paragraph)node.dataset.paragraphNum=p.paragraph.replaceAll('_','-');
        if(p.item){node.classList.add('law-item');node.dataset.itemNum=p.item.replaceAll('_','-');}
        else if(p.paragraph)node.classList.add('law-paragraph');
      });
    }
    root.replaceChildren(...doc.body.childNodes);
    return {title,lawNum};
  }
  globalThis.EgovNormalCacheReader=Object.freeze({xml,html});
})();
