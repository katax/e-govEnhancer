// MAIN world, document_start. Leave e-Gov's Vue renderer and Enhancer processing intact.
(() => {
  const channel = 'egov-normal-response-cache-v1';
  const pending = new Map();
  const states = new WeakMap();
  const proto = XMLHttpRequest.prototype;
  const native = { open: proto.open, send: proto.send, abort: proto.abort, setRequestHeader: proto.setRequestHeader };
  const synthetic = ['readyState', 'status', 'statusText', 'responseURL', 'responseText', 'response',
    'getAllResponseHeaders', 'getResponseHeader'];
  const prefix = crypto.randomUUID();
  let sequence = 0;

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== channel
        || data.direction !== 'response') return;
    pending.get(data.id)?.(data.value);
  });
  function read(request, build) {
    return new Promise(resolve => {
      const id = `${prefix}:${++sequence}`;
      const done = value => { clearTimeout(timer); pending.delete(id); resolve(value); };
      const timer = setTimeout(() => done(null), 1500);
      pending.set(id, done);
      window.postMessage({ channel, direction: 'request', id, action: 'get', request, build }, location.origin);
    });
  }
  function eligible(s, xhr, body) {
    if (!s || !s.async || s.auth || s.customHeaders || xhr.timeout || xhr.withCredentials
        || !['', 'text', 'json'].includes(xhr.responseType) || !/^\/law\/[0-9A-Z]{15}(?:\/|$)/.test(location.pathname)) return false;
    const url = new URL(s.url);
    return url.origin === location.origin && !url.search && !url.hash
      && ((s.method === 'POST' && typeof body === 'string' && body.length <= 256000
        && /^\/internal-api\/SelectLaw(?:Revision|Toc|Text)?Data\.json$/.test(url.pathname))
        || (s.method === 'GET' && body === null && /^\/data\/.*_law\.html$/.test(url.pathname)));
  }
  proto.open = function(method, url, async = true, ...auth) {
    const previous = states.get(this);
    if (previous) previous.cancelled = true;
    if (previous?.synthetic) for (const name of synthetic) delete this[name];
    const result = native.open.call(this, method, url, async, ...auth);
    states.set(this, { method: String(method).toUpperCase(), url: new URL(url, location.href).href,
      async: async !== false, auth: auth.some(value => value != null), cancelled: false, sent: false, headers: [] });
    return result;
  };
  proto.setRequestHeader = function(name, value) {
    const result = native.setRequestHeader.call(this, name, value);
    const s = states.get(this);
    if (s && !['accept', 'content-type', 'content-encoding', 'x-requested-with'].includes(String(name).toLowerCase())) s.customHeaders = true;
    else if (s) s.headers.push([String(name).toLowerCase(), String(value)]);
    return result;
  };
  proto.abort = function() {
    const s = states.get(this);
    if (s?.synthetic) for (const name of synthetic) delete this[name];
    if (s?.sent && !s.started && !s.cancelled && !s.synthetic) {
      s.cancelled = true;
      native.abort.call(this);
      this.dispatchEvent(new ProgressEvent('abort'));
      this.dispatchEvent(new ProgressEvent('loadend'));
      return;
    }
    if (s) s.cancelled = true;
    return native.abort.call(this);
  };
  proto.send = function(body = null) {
    const xhr = this, s = states.get(xhr);
    if (!eligible(s, xhr, body)) return native.send.call(xhr, body);
    if (s.sent) throw new DOMException('The request has already been sent.', 'InvalidStateError');
    s.sent = true;
    const request = { method: s.method, url: s.url, body: body || '', headers: s.headers };
    const build = Array.from(document.querySelectorAll('script[type="module"][src]'), node => node.src).sort().join('|');
    const live = () => {
      if (s.cancelled || s.started || s.synthetic) return;
      s.started = true;
      const failed = () => {
        if (s.cancelled || states.get(xhr) !== s) return;
        window.postMessage({ channel, direction: 'notice', request, failed: true }, location.origin);
      };
      xhr.addEventListener('error', failed, { once: true });
      xhr.addEventListener('timeout', failed, { once: true });
      xhr.addEventListener('load', () => {
        if (s.cancelled || states.get(xhr) !== s) return;
        if (xhr.status !== 200) return failed();
        const downloadedAt = Date.now();
        window.postMessage({ channel, direction: 'notice', request, downloadedAt }, location.origin);
        const text = xhr.responseType === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
        if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) return;
        window.postMessage({ channel, direction: 'request', id: `${prefix}:${++sequence}`, action: 'put',
          request, build, value: { text, contentType: xhr.getResponseHeader('content-type') || '', downloadedAt } }, location.origin);
      }, { once: true });
      // Force a server round trip even when the native browser HTTP cache is warm.
      native.setRequestHeader.call(xhr, 'Cache-Control', 'no-cache');
      native.send.call(xhr, body);
    };
    read(request, build).then(cached => {
      if (s.cancelled || states.get(xhr) !== s) return;
      if (!cached || typeof cached.text !== 'string' || !cached.text
          || typeof cached.contentType !== 'string') return live();
      const response = xhr.responseType === 'json' ? JSON.parse(cached.text) : cached.text;
      const properties = {
        readyState: { get: () => 4 }, status: { get: () => 200 }, statusText: { get: () => 'OK' },
        responseURL: { get: () => s.url }, response: { get: () => response },
        responseText: { get: () => {
          if (xhr.responseType === 'json') throw new DOMException('responseType is json', 'InvalidStateError');
          return cached.text;
        } },
        getAllResponseHeaders: { value: () => `content-type: ${cached.contentType}\r\n` },
        getResponseHeader: { value: name => String(name).toLowerCase() === 'content-type' ? cached.contentType : null },
      };
      for (const property of Object.values(properties)) property.configurable = true;
      Object.defineProperties(xhr, properties);
      s.synthetic = true;
      window.postMessage({ channel, direction: 'notice', request, downloadedAt: cached.downloadedAt }, location.origin);
      for (const type of ['loadstart', 'readystatechange', 'progress', 'load', 'loadend']) {
        if (s.cancelled || states.get(xhr) !== s) break;
        xhr.dispatchEvent(new ProgressEvent(type));
      }
    }).catch(live);
  };
})();
