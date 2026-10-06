// Substituto mínimo do SDK compat do Firebase Realtime Database, para teste.
(function () {
  function limpo(v) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) { var a = v.map(limpo).filter(function (x) { return x !== undefined; }); return a.length ? a : undefined; }
    if (typeof v === 'object') { var o = {}; Object.keys(v).sort().forEach(function (k) { var x = limpo(v[k]); if (x !== undefined) o[k] = x; }); return Object.keys(o).length ? o : undefined; }
    return v;
  }
  function canon(v) { var c = limpo(v); return c === undefined ? '' : JSON.stringify(c); }
  var cbs = {}; // caminho -> [callbacks]
  window.__fbNotify = function (p, v) { (cbs[p] || []).slice().forEach(function (cb) { try { cb(snap(v)); } catch (e) { console.error('listener: ' + (e && e.stack || e)); } }); };
  function snap(v) { return { val: function () { return v === undefined ? null : v; } }; }
  function coberto(p) { return Object.keys(cbs).some(function (lp) { return cbs[lp].length && (p === lp || p.indexOf(lp + '/') === 0); }); }
  function Ref(p) { this.p = p.replace(/^\/+|\/+$/g, ''); }
  Ref.prototype.child = function (k) { return new Ref(this.p + '/' + k); };
  Ref.prototype.on = function (ev, cb) { (cbs[this.p] = cbs[this.p] || []).push(cb); window.__fb_listen(this.p); return cb; };
  Ref.prototype.off = function () { cbs[this.p] = []; window.__fb_unlisten(this.p); };
  Ref.prototype.once = function () { var p = this.p; return new Promise(function (res) { setTimeout(function () { window.__fb_get(p).then(function (v) { res(snap(v)); }); }, window.__fbAtrasoOnce || 30); }); };
  Ref.prototype.set = function (v) { return window.__fb_set(this.p, v === undefined ? null : v).then(function () { }); };
  Ref.prototype.update = function (o) { var self = this; return Promise.all(Object.keys(o).map(function (k) { return self.child(k).set(o[k]); })).then(function () { }); };
  Ref.prototype.transaction = function (fn) {
    var p = this.p;
    // Como no SDK real: sem listener cobrindo o caminho, a 1ª tentativa roda com null.
    var primeiro = coberto(p) ? window.__fb_get(p) : Promise.resolve(null);
    function tentar(atual, n) {
      var novo = fn(atual === undefined ? null : atual);
      if (novo === undefined) return Promise.resolve({ committed: false, snapshot: snap(atual) });
      return window.__fb_cas(p, canon(atual), novo).then(function (r) {
        if (r.ok) return { committed: true, snapshot: snap(r.val) };
        if (n > 20) throw new Error('transaction: muitas tentativas');
        return tentar(r.val, n + 1);
      });
    }
    return primeiro.then(function (v) { return tentar(v, 0); });
  };
  var db = { ref: function (p) { return new Ref(p || ''); }, setPersistenceEnabled: function () { throw new Error('n/a'); } };
  window.firebase = { initializeApp: function () { }, database: function () { return db; } };
})();
