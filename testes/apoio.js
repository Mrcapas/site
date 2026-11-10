// Apoio dos testes: um banco Firebase falso (no Node) e clientes que são as páginas reais do
// sistema abertas no Chromium. Nenhum teste toca no Firebase de verdade.
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const fs = require('fs');

function limpo(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) { const a = v.map(limpo).filter(x => x !== undefined); return a.length ? a : undefined; }
  if (typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach(k => { const x = limpo(v[k]); if (x !== undefined) o[k] = x; }); return Object.keys(o).length ? o : undefined; }
  return v;
}
const canon = v => { const c = limpo(v); return c === undefined ? '' : JSON.stringify(c); };
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

class Servidor {
  constructor() { this.raiz = {}; this.clientes = []; this.escritas = 0; this.log = []; }
  partes(p) { return p.split('/').filter(Boolean); }
  get(p) { let n = this.raiz; for (const k of this.partes(p)) { if (n === null || typeof n !== 'object') return null; n = n[k]; if (n === undefined) return null; } return clone(n); }
  set(p, v, quem) {
    const ps = this.partes(p); this.escritas++; this.log.push({ quem, p, bytes: canon(v).length });
    const val = limpo(v);
    let n = this.raiz;
    for (let i = 0; i < ps.length - 1; i++) { if (n[ps[i]] === undefined || typeof n[ps[i]] !== 'object') n[ps[i]] = {}; n = n[ps[i]]; }
    if (val === undefined) delete n[ps[ps.length - 1]]; else n[ps[ps.length - 1]] = clone(val);
    this.avisar(p);
  }
  avisar(p) {
    for (const c of this.clientes) for (const lp of c.ouvindo) {
      if (p === lp || p.startsWith(lp + '/') || lp.startsWith(p + '/')) c.entregar(lp, 5);
    }
  }
}

const FAKE = fs.readFileSync(__dirname + '/firebase-falso.js', 'utf8');

async function abrirCliente(browser, srv, nome, html, opts = {}) {
  const ctx = opts.ctx || await browser.newContext();
  const page = await ctx.newPage();
  const c = { nome, page, ctx, ouvindo: new Set(), atrasoInicial: opts.atrasoInicial ?? 150, erros: [] };
  c.online = !opts.offline; c.fila = [];
  const quandoOnline = () => c.online ? Promise.resolve() : new Promise(r => c.fila.push(r));
  c.conectar = () => { c.online = true; c.fila.splice(0).forEach(r => r()); c.info(); c.ouvindo.forEach(lp => c.entregar(lp, 20)); };
  c.entregar = (lp, ms) => setTimeout(() => {
    if (!c.ouvindo.has(lp) || !c.online) return;
    page.evaluate(([p, v]) => window.__fbNotify(p, v), [lp, srv.get(lp)]).catch(() => {});
  }, ms);
  c.info = () => page.evaluate(v => window.__fbNotify('.info/connected', v), c.online).catch(() => {});
  c.desconectar = () => { c.online = false; c.info(); };
  srv.clientes.push(c);
  page.on('pageerror', e => c.erros.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') c.erros.push(m.text()); });
  await page.exposeFunction('__fb_get', async p => { await quandoOnline(); return srv.get(p); });
  await page.exposeFunction('__fb_set', async (p, v) => { await quandoOnline(); srv.set(p, v, nome); return true; });
  await page.exposeFunction('__fb_cas', async (p, esperado, v) => {
    await quandoOnline();
    const atual = srv.get(p);
    if (canon(atual) !== esperado) return { ok: false, val: atual };
    srv.set(p, v, nome); return { ok: true, val: srv.get(p) };
  });
  await page.exposeFunction('__fb_listen', p => { if (p === '.info/connected') { setTimeout(c.info, 10); return true; } c.ouvindo.add(p); c.entregar(p, c.atrasoInicial); return true; });
  await page.exposeFunction('__fb_unlisten', p => { c.ouvindo.delete(p); return true; });
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('firebase-app-compat')) return route.fulfill({ contentType: 'application/javascript', body: FAKE });
    if (u.includes('firebase-database-compat')) return route.fulfill({ contentType: 'application/javascript', body: '/* fake */' });
    if (route.request().resourceType() === 'document' && u.startsWith('https://www.mrcapas.com.br/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    return route.abort();
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('srcapas_auth', 'teste'); } catch (e) {} });
  if (opts.localInicial) await page.addInitScript(dados => {
    if (localStorage.getItem('__semeado')) return;
    Object.keys(dados).forEach(k => localStorage.setItem(k, dados[k])); localStorage.setItem('__semeado', '1');
  }, opts.localInicial);
  await page.goto(opts.url || 'https://www.mrcapas.com.br/financeiro/', { waitUntil: 'load' });
  c.ev = (fn, arg) => page.evaluate(fn, arg);
  c.local = k => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  c.fechar = () => { srv.clientes = srv.clientes.filter(x => x !== c); return ctx.close(); };
  return c;
}
const espera = ms => new Promise(r => setTimeout(r, ms));
module.exports = { chromium, Servidor, abrirCliente, espera, canon };
