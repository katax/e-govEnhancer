// Verification only: MAIN-world, early XHR interception. Not product code.
// Only the observed read-only law endpoints are eligible; all others use XHR.
(() => {
  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open, nativeSend = proto.send, nativeAbort = proto.abort;
  const state = new WeakMap();
  const paths = new Set(['SelectLawRevisionData.json','SelectLawTocData.json','SelectLawData.json','SelectLawTextData.json']);
  proto.open = function(method, url, async = true, ...rest) {
    state.set(this,{ method:String(method).toUpperCase(), url:new URL(url,location.href).href,
      async:async!==false, aborted:false, started:false });
    return nativeOpen.call(this,method,url,async,...rest);
  };
  proto.abort = function() {
    const s=state.get(this);
    if(s&&!s.started&&!s.aborted) {s.aborted=true;this.dispatchEvent(new ProgressEvent('abort'));}
    return nativeAbort.call(this);
  };
  proto.send = function(body = null) {
    const xhr=this,s=state.get(xhr);
    if(!s) return nativeSend.call(xhr,body);
    const url=new URL(s.url);
    const eligible=url.origin===location.origin&&s.async&&['','text','json'].includes(xhr.responseType)
      &&(s.method==='POST'&&url.pathname.startsWith('/internal-api/')&&paths.has(url.pathname.split('/').at(-1))
        ||s.method==='GET'&&url.pathname.startsWith('/data/')&&url.pathname.endsWith('_law.html'));
    const live=()=>{if(!s.aborted){s.started=true;nativeSend.call(xhr,body);}};
    if(!eligible) return live();
    Promise.resolve(window.__readCachedLawResponse({method:s.method,url:s.url,body:body||''}))
      .then(cached=>{
        if(s.aborted)return;
        if(!cached)return live();
        const headers=cached.headers;
        const value=xhr.responseType==='json'?JSON.parse(cached.text):cached.text;
        Object.defineProperties(xhr,{
          readyState:{configurable:true,get:()=>4},status:{configurable:true,get:()=>200},
          statusText:{configurable:true,get:()=> 'OK'},responseURL:{configurable:true,get:()=>s.url},
          responseText:{configurable:true,get:()=>cached.text},response:{configurable:true,get:()=>value},
        });
        xhr.getAllResponseHeaders=()=>Object.entries(headers).map(([k,v])=>k+': '+v).join('\r\n');
        xhr.getResponseHeader=name=>headers[String(name).toLowerCase()]||null;
        for(const name of ['readystatechange','load','loadend'])xhr.dispatchEvent(new ProgressEvent(name));
      }).catch(live);
  };
})();
