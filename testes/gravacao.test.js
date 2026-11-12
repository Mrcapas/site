// Testes da camada de gravação/sincronização do financeiro.
// Rodam a página real (financeiro/index.html) no Chromium contra um Firebase falso.
// Uso:  node testes/gravacao.test.js            (todos)
//       node testes/gravacao.test.js R1 R3      (só os que começam com esses códigos)
//       BACKUP_JSON=/caminho/export.json node testes/gravacao.test.js REAL
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium, Servidor, abrirCliente, espera, canon } = require('./apoio');

const RAIZ_REPO = path.join(__dirname, '..');
// PAGINA=/caminho/outro.html permite rodar os mesmos testes contra outra versão da página.
const NOVO = fs.readFileSync(process.env.PAGINA || path.join(RAIZ_REPO, 'financeiro', 'index.html'), 'utf8');
const TEC = fs.readFileSync(path.join(RAIZ_REPO, 'tecnico-teste', 'index.html'), 'utf8');
// Versão antiga (a que estava em produção antes da correção), lida do histórico do Git.
const COMMIT_ANTIGO = '46671b8';
let ANTIGO = null;
try { ANTIGO = execSync('git show ' + COMMIT_ANTIGO + ':financeiro/index.html', { cwd: RAIZ_REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (e) {}

const d = new Date(), mm = d.getFullYear() + '_' + String(d.getMonth() + 1).padStart(2, '0');
const K = (t, l) => 'srcapas_' + t + '_' + l + '_' + mm;
const KE = K('entradas', 'bacaxa'), KA = K('entradas', 'araruama');
const ids = a => (Array.isArray(a) ? a : []).map(x => x.id).sort().join(',');
const semRede = c => c.erros.filter(e => !/ERR_FAILED/.test(e));
const PFX = 'V2!'; // prefixo do armazenamento da versão nova em produção
const base = () => ({ srcapas: {
  bacaxa: { _ts: 1, srcapas_funcionarios_bacaxa: [{ id: 'f1', nome: 'Kaua', vendedor: true }],
    [KE]: [1, 2, 3, 4, 5].map(i => ({ id: 'e' + i, data: '2026-10-0' + i, din: i * 10, pix: 0 })) },
  araruama: { _ts: 1, srcapas_funcionarios_araruama: [{ id: 'f2', nome: 'Ramon', vendedor: true }],
    [KA]: [1, 2, 3, 4, 5].map(i => ({ id: 'a' + i, data: '2026-10-0' + i, din: i })) },
} });
const lancar = (c, id, extra) => c.ev(([id, extra]) => { const a = load('entradas'); a.push(Object.assign({ id: id, data: today(), din: 1 }, extra || {})); save('entradas', a); }, [id, extra]);
const resgatados = srv => { const out = []; const r = srv.get('srcapas_resgate') || {};
  Object.values(r).forEach(loja => Object.values(loja).forEach(ap => Object.values(ap).forEach(item => (item.itens || []).forEach(i => out.push(i.registro && i.registro.id !== undefined ? i.registro.id : JSON.stringify(i.registro)))))); return out.sort(); };

const testes = [];
const T = (cod, nome, fn) => testes.push({ cod, nome, fn });

T('T1', 'cenário da perda original: a versão antiga apaga, a nova não', async (browser, ok) => {
  async function rodar(html) {
    const srv = new Servidor(); srv.raiz = base();
    srv.raiz.srcapas.bacaxa.srcapas_custos_tpl_bacaxa = [{ id: 't1', cat: 'FIXO', nome: 'Aluguel', val: 100, diaVenc: 5, forma: 'PIX', ativo: true }];
    srv.raiz.srcapas.bacaxa[KE] = [{ id: 'e0', data: '2026-10-01', din: 10 }];
    const B = await abrirCliente(browser, srv, 'B', html); await espera(600);
    await B.ev(() => changeEmpresa('araruama')); await espera(600);
    await lancar(B, 'x1'); await espera(400);
    const A = await abrirCliente(browser, srv, 'A', html); await espera(600);
    for (let i = 1; i <= 20; i++) { await lancar(A, 'e' + i); await espera(40); }
    await espera(500);
    await B.ev(() => setTab('verificacao')); await espera(300);
    await B.ev(() => changeEmpresa('bacaxa')); await espera(1500);
    const n = (srv.get('srcapas/bacaxa/' + KE) || []).length;
    await A.fechar(); await B.fechar(); return n;
  }
  if (ANTIGO) ok('a versão antiga perde (sanidade do teste)', (await rodar(ANTIGO)) < 21);
  ok('a versão nova mantém as 21 entradas', (await rodar(NOVO)) === 21);
});

T('T2', 'concorrência entre dois computadores na mesma loja', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO), B = await abrirCliente(browser, srv, 'B', NOVO); await espera(700);
  await Promise.all([lancar(A, 'novoA'), lancar(B, 'novoB')]); await espera(900);
  let s = srv.get('srcapas/bacaxa/' + KE);
  ok('lançamentos simultâneos: os dois ficam', ids(s) === 'e1,e2,e3,e4,e5,novoA,novoB' && ids(await A.local(KE)) === ids(s) && ids(await B.local(KE)) === ids(s), ids(s));
  await A.ev(() => save('entradas', load('entradas').filter(x => x.id !== 'e3'))); await espera(600);
  await lancar(B, 'novoB2'); await espera(800);
  s = srv.get('srcapas/bacaxa/' + KE);
  ok('exclusão propaga e não volta', !ids(s).includes('e3') && ids(s).includes('novoB2') && ids(await A.local(KE)) === ids(s), ids(s));
  await Promise.all([
    A.ev(() => { const a = load('entradas'); a.find(x => x.id === 'e1').din = 111; a.find(x => x.id === 'e2').din = 222; save('entradas', a); }),
    B.ev(() => { const a = load('entradas'); a.find(x => x.id === 'e1').pix = 999; a.find(x => x.id === 'e4').din = 444; save('entradas', a); }),
  ]); await espera(900);
  s = srv.get('srcapas/bacaxa/' + KE); const g = id => s.find(x => x.id === id);
  ok('edições simultâneas em campos diferentes se somam', g('e1').din === 111 && g('e1').pix === 999 && g('e2').din === 222 && g('e4').din === 444);
  const antes = srv.escritas;
  await A.ev(() => { const a = load('saidas'); a.push({ id: 's1', data: today(), val: 5, boleto: null, comprovante: null, obs: '' }); save('saidas', a); }); await espera(1500);
  ok('campos nulos não deixam pendência nem laço de gravação', (await A.ev(() => _contarPend())) === 0 && (await B.ev(() => _contarPend())) === 0 && srv.escritas - antes <= 4, srv.escritas - antes);
  ok('sem erros de JavaScript', semRede(A).length === 0 && semRede(B).length === 0, semRede(A).concat(semRede(B)));
  await A.fechar(); await B.fechar();
});

T('T5', 'sem internet ao abrir', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(600);
  const local0 = {}; local0[PFX + KE] = JSON.stringify(srv.get('srcapas/bacaxa/' + KE));
  local0[PFX + 'mrc_perfil:U'] = JSON.stringify({ nome: 'Teste', perfil: 'admin' }); // aparelho que já entrou antes
  const B = await abrirCliente(browser, srv, 'B', NOVO, { offline: true, localInicial: local0 });
  await lancar(A, 'online1'); await espera(8600);
  const status = await B.ev(() => document.getElementById('sync-status').textContent);
  await lancar(B, 'offline1'); await espera(300);
  const durante = ids(srv.get('srcapas/bacaxa/' + KE)), pend = await B.ev(() => _contarPend());
  B.conectar(); await espera(1500);
  const s = ids(srv.get('srcapas/bacaxa/' + KE));
  ok('offline não grava por cima; ao reconectar, mescla', /Sem conex/.test(status) && pend === 1 && !durante.includes('offline1') && s === 'e1,e2,e3,e4,e5,offline1,online1' && ids(await B.local(KE)) === s && (await B.ev(() => _contarPend())) === 0, { status, durante, s });
  await A.fechar(); await B.fechar();
});

T('T7', 'isolamento por loja', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  srv.raiz.srcapas.bacaxa[KA] = [{ id: 'a1', data: '2026-10-01', din: 1 }]; // cópia velha de Araruama dentro do nó de Bacaxá
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(600);
  await A.ev(() => changeEmpresa('araruama')); await espera(700);
  const c1 = ids(await A.local(KA));
  await A.ev(() => changeEmpresa('bacaxa')); await espera(700);
  const c2 = ids(await A.local(KA));
  await lancar(A, 'b9'); await espera(600);
  ok('cópias de outras lojas são ignoradas e não são regravadas', c1 === 'a1,a2,a3,a4,a5' && c2 === c1 && ids(srv.get('srcapas/araruama/' + KA)) === c1 && ids(srv.get('srcapas/bacaxa/' + KA)) === 'a1');
  await A.ev(() => { const a = load('entradas'); a.push({ id: 'rapido', data: today(), din: 1 }); save('entradas', a); changeEmpresa('araruama'); }); await espera(1200);
  const b = ids(srv.get('srcapas/bacaxa/' + KE)), a = ids(srv.get('srcapas/araruama/' + KA));
  ok('lançar e trocar de loja em seguida grava na loja certa', b.includes('rapido') && !a.includes('rapido') && Object.keys(srv.get('srcapas/araruama')).filter(k => k.includes('bacaxa')).length === 0);
  ok('sem erros de JavaScript', semRede(A).length === 0, semRede(A));
  await A.fechar();
});

T('T8', 'dados deixados no navegador pela versão antiga', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const local0 = {};
  local0[K('saidas', 'bacaxa')] = JSON.stringify([{ id: 'so1', data: '2026-10-02', val: 50 }, { id: 'so2', data: '2026-10-03', val: 60 }]);
  local0[KE] = JSON.stringify([{ id: 'e1', data: '2026-10-01', din: 10, pix: 0 }, { id: 'velha1', data: '2026-10-02', din: 1 }]);
  const A = await abrirCliente(browser, srv, 'A', NOVO, { localInicial: local0 }); await espera(1500);
  ok('não entram sozinhos nos dados (nada ressuscita)', ids(srv.get('srcapas/bacaxa/' + KE)) === 'e1,e2,e3,e4,e5' && srv.get('srcapas/bacaxa/' + K('saidas', 'bacaxa')) === null);
  ok('vão para a área de resgate', resgatados(srv).join(',') === 'so1,so2,velha1', resgatados(srv));
  ok('os dados antigos do navegador ficam intactos', (await A.ev(k => _lsGetRaw.call(localStorage, k), KE)) === local0[KE]);
  const n1 = Object.keys((srv.get('srcapas_resgate/bacaxa') || {})[Object.keys(srv.get('srcapas_resgate/bacaxa') || { x: 1 })[0]] || {}).length;
  await A.page.reload({ waitUntil: 'load' }); await espera(1500);
  const n2 = Object.keys((srv.get('srcapas_resgate/bacaxa') || {})[Object.keys(srv.get('srcapas_resgate/bacaxa') || { x: 1 })[0]] || {}).length;
  ok('a conferência acontece uma vez só', n1 === n2 && n1 === 2, { n1, n2 });
  ok('a cópia local do resgate some depois de confirmada', (await A.ev(() => _chaves('mrc_q:').length)) === 0);
  await A.fechar();
});

T('T12', 'teste e oficial no mesmo navegador (projetos Firebase separados)', async (browser, ok) => {
  const srvP = new Servidor(); srvP.raiz = base();
  const srvT = new Servidor(); srvT.raiz = base();
  const P = await abrirCliente(browser, srvP, 'P', NOVO); await espera(700);
  const Tt = await abrirCliente(browser, srvT, 'T', NOVO, { ctx: P.ctx, url: 'https://www.mrcapas.com.br/financeiro-teste/' }); await espera(900);
  await lancar(Tt, 'FALSO1'); await Tt.ev(() => changeEmpresa('araruama')); await espera(700);
  await lancar(Tt, 'FALSO3'); await espera(800);
  await P.page.reload({ waitUntil: 'load' }); await espera(1200);
  await P.ev(() => changeEmpresa('araruama')); await espera(900);
  await lancar(P, 'realNovo'); await espera(900);
  const real = JSON.stringify(srvP.get('srcapas')), teste = JSON.stringify(srvT.get('srcapas'));
  const cfgP = await P.ev(() => ({ db: _FB_CFG.databaseURL, pfx: _PFX })), cfgT = await Tt.ev(() => ({ db: _FB_CFG.databaseURL, pfx: _PFX }));
  ok('cada endereço usa o seu projeto Firebase', cfgP.db.indexOf('finan-mrcapas-default') >= 0 && cfgT.db.indexOf('finan-mrcapas-teste') >= 0, { cfgP, cfgT });
  ok('armazenamento do navegador separado (V2! x TESTE!)', cfgP.pfx === 'V2!' && cfgT.pfx === 'TESTE!', { cfgP, cfgT });
  ok('não se misturam', !real.includes('FALSO') && real.includes('realNovo') && teste.includes('FALSO1') && teste.includes('FALSO3') && !teste.includes('realNovo'));
  await P.ctx.close();
});

T('R1', 'versão antiga aberta no mesmo navegador (aba antiga e página da raiz)', async (browser, ok) => {
  if (!ANTIGO) return ok('versão antiga disponível no Git', false);
  for (const url of ['https://www.mrcapas.com.br/financeiro/', 'https://www.mrcapas.com.br/']) {
    const srv = new Servidor(); srv.raiz = base();
    srv.raiz.srcapas.araruama[KE] = srv.raiz.srcapas.bacaxa[KE].slice(0, 1); // cópia velha de Bacaxá no nó de Araruama
    const V = await abrirCliente(browser, srv, 'aba-antiga', ANTIGO, { url }); await espera(600);
    await V.ev(() => changeEmpresa('araruama')); await espera(700);
    const N = await abrirCliente(browser, srv, 'aba-nova', NOVO, { ctx: V.ctx }); await espera(900);
    const O = await abrirCliente(browser, srv, 'outro-pc', NOVO); await espera(700);
    for (let i = 6; i <= 15; i++) { await lancar(O, 'e' + i); await espera(40); }
    await espera(600);
    await O.ev(() => changeEmpresa('araruama')); await espera(700);
    await lancar(O, 'ara1'); await espera(3800); // a aba antiga reaplica a cópia velha no localStorage dela
    const velho = (JSON.parse(await N.ev(k => _lsGetRaw.call(localStorage, k), KE) || '[]')).length;
    await lancar(N, 'novoNaAbaNova'); await espera(1500);
    const s = srv.get('srcapas/bacaxa/' + KE) || [];
    ok('[' + url.replace('https://www.mrcapas.com.br', '') + '] a aba nova não apaga o servidor', s.length === 16 && ids(s).includes('novoNaAbaNova') && velho === 1, { servidor: s.length, copiaVelhaDaAbaAntiga: velho });
    await V.ctx.close(); await O.fechar();
  }
});

T('R2', 'recarregar a página com envio pendente', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO), O = await abrirCliente(browser, srv, 'O', NOVO); await espera(800);
  A.desconectar();
  await lancar(A, 'pendente'); await espera(200);
  await O.ev(() => save('entradas', load('entradas').filter(x => x.id !== 'e2' && x.id !== 'e3'))); await espera(500);
  await O.ev(() => { const a = load('entradas'); a.find(x => x.id === 'e4').din = 444; save('entradas', a); }); await espera(500);
  await A.page.reload({ waitUntil: 'load' }).catch(() => {}); await espera(400); A.conectar(); await espera(2000);
  const s = srv.get('srcapas/bacaxa/' + KE);
  ok('o lançamento pendente sobe e o que os outros fizeram é respeitado', ids(s) === 'e1,e4,e5,pendente' && s.find(x => x.id === 'e4').din === 444, { ids: ids(s) });
  ok('nada fica pendente', (await A.ev(() => _contarPend())) === 0);
  await A.fechar(); await O.fechar();
});

T('R3', 'duas abas da versão nova no mesmo navegador', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const T1 = await abrirCliente(browser, srv, 'aba1', NOVO); await espera(700);
  const T2 = await abrirCliente(browser, srv, 'aba2', NOVO, { ctx: T1.ctx }); await espera(700);
  const O = await abrirCliente(browser, srv, 'outro-pc', NOVO); await espera(700);
  T1.desconectar();
  await lancar(T1, 'daAba1'); await espera(200);
  await lancar(O, 'doOutroPc'); await espera(900);
  const local = ids(await T1.local(KE));
  T1.conectar(); await espera(3500);
  const s = ids(srv.get('srcapas/bacaxa/' + KE));
  ok('a aba 2 não apaga o lançamento pendente da aba 1', local.includes('daAba1') && local.includes('doOutroPc'), local);
  ok('os dois lançamentos chegam ao servidor', s === 'daAba1,doOutroPc,e1,e2,e3,e4,e5', s);
  ok('nada fica pendente', (await T1.ev(() => _contarPend())) === 0);
  await T1.ctx.close(); await O.fechar();
});

T('R4', 'dado que o banco não aceita e falha na hora do envio', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(700);
  const r = await A.ev(() => { try { saveO('mk_vend', { 'Jo.ao': { Capas: 1 } }); return 'gravou'; } catch (e) { return 'recusou'; } });
  const aviso = await A.ev(() => document.getElementById('notif').textContent);
  ok('nome com caractere inválido é recusado com aviso', r === 'recusou' && /caractere/.test(aviso) && (await A.ev(() => _contarPend())) === 0, { r, aviso });
  // o SDK real lança exceção síncrona em transaction(); a chave não pode ficar presa
  await A.ev(() => { const P = Object.getPrototypeOf(_db.ref('x')); window.__orig = P.transaction; let n = 0; P.transaction = function (fn) { if (n++ === 0) throw new Error('transaction failed: simulado'); return window.__orig.call(this, fn); }; });
  await lancar(A, 'aposErro'); await espera(600);
  const preso = await A.ev(() => _enviando.size), pend1 = await A.ev(() => _contarPend());
  await A.ev(() => pushToFB()); await espera(900);
  ok('falha no envio não prende a chave e o reenvio funciona', preso === 0 && pend1 === 1 && ids(srv.get('srcapas/bacaxa/' + KE)).includes('aposErro') && (await A.ev(() => _contarPend())) === 0, { preso, pend1 });
  await A.fechar();
});

T('R5', 'rede de segurança: sem teto, cobre objetos, só some depois de confirmada', async (browser, ok) => {
  const srv = new Servidor(); const node = { _ts: 1 }; const local0 = {};
  for (let i = 0; i < 40; i++) { const k = 'srcapas_saidas_bacaxa_' + (2020 + Math.floor(i / 12)) + '_' + String((i % 12) + 1).padStart(2, '0');
    node[k] = [{ id: 's' + i, data: '2020-01-01', val: 1 }];
    local0[PFX + k] = JSON.stringify([{ id: 's' + i, data: '2020-01-01', val: 1 }, { id: 'x' + i + 'a', val: 2 }, { id: 'x' + i + 'b', val: 2 }, { id: 'x' + i + 'c', val: 2 }]); }
  srv.raiz = { srcapas: { bacaxa: node } };
  const A = await abrirCliente(browser, srv, 'A', NOVO, { localInicial: local0 }); await espera(2000);
  ok('40 chaves divergentes ao abrir: 120 registros guardados (sem teto de 30)', resgatados(srv).length === 120, resgatados(srv).length);
  await A.fechar();
  // objeto sem id (func_mes) encolhendo ao vivo, com o resgate sem conseguir subir
  const srv2 = new Servidor(); srv2.raiz = base();
  const kf = K('func_mes', 'bacaxa');
  srv2.raiz.srcapas.bacaxa[kf] = { f1: { sal: 1000, st: 'PAGO' }, f2: { sal: 900, st: 'PAGO' }, f3: { sal: 800, st: 'PENDENTE' } };
  const B = await abrirCliente(browser, srv2, 'B', NOVO); await espera(800);
  await B.ev(() => { const P = Object.getPrototypeOf(_db.ref('x')); window.__set = P.set; P.set = function (v) { if (this.p.indexOf('_resgate') >= 0) return Promise.reject(new Error('sem rede')); return window.__set.call(this, v); }; });
  srv2.set('srcapas/bacaxa/' + kf, { f1: { sal: 1000, st: 'PAGO' } }, 'versao-antiga'); await espera(700);
  const q1 = await B.ev(() => _chaves('mrc_q:').length);
  ok('objeto sem id também é guardado, e fica no navegador enquanto o servidor não confirma', q1 === 1 && resgatados(srv2).length === 0, { q1 });
  await B.ev(() => { Object.getPrototypeOf(_db.ref('x')).set = window.__set; _enviarQuarentena(); }); await espera(600);
  ok('depois de confirmado, some do navegador e está no servidor', (await B.ev(() => _chaves('mrc_q:').length)) === 0 && resgatados(srv2).length === 2, resgatados(srv2));
  await B.fechar();
});

T('R7', 'pendência de uma loja que não é reaberta', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(700);
  await A.ev(() => changeEmpresa('araruama')); await espera(700);
  A.desconectar(); await espera(100);
  await lancar(A, 'pendAra'); await espera(200);
  const st = await A.ev(() => document.getElementById('sync-status').textContent);
  await A.page.reload({ waitUntil: 'load' }).catch(() => {}); await espera(400); A.conectar(); await espera(2500);
  ok('offline mostra quantas alterações estão guardadas', /Sem conex.*1 altera/.test(st), st);
  ok('ao reabrir em outra loja, a pendência de Araruama é enviada', (await A.ev(() => ST.empresa)) === 'bacaxa' && ids(srv.get('srcapas/araruama/' + KA)).includes('pendAra') && (await A.ev(() => _contarPend())) === 0);
  await A.fechar();
});

T('R8', 'loja fora da lista e erros visíveis', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(700);
  const r = await A.ev(() => { ST.empresa = 'cabofrio'; try { save('entradas', [{ id: 'cf1', data: today(), din: 1 }]); return 'gravou'; } catch (e) { return 'recusou'; } });
  const aviso = await A.ev(() => document.getElementById('notif').textContent);
  ok('loja desconhecida: recusa com aviso, nada silencioso', r === 'recusou' && /não está cadastrada/.test(aviso), { r, aviso });
  ok('loja nova no seletor entra sozinha na sincronização', await A.ev(() => _LOJAS_SYNC.join(',') === Array.from(document.querySelectorAll('#empresa-sel option')).map(o => o.value).sort((a, b) => b.length - a.length).join(',')));
  await A.fechar();
  // navegador sem espaço ao receber dados
  const srv2 = new Servidor(); srv2.raiz = base();
  const B = await abrirCliente(browser, srv2, 'B', NOVO); await espera(700);
  await B.ev(() => { let bloco = 'x'.repeat(256 * 1024), i = 0; try { for (; i < 400; i++) _lsSetRaw.call(localStorage, 'lixo' + i, bloco); } catch (e) {} bloco = 'x'.repeat(1024); try { for (let j = 0; j < 4000; j++) _lsSetRaw.call(localStorage, 'lixinho' + j, bloco); } catch (e) {} });
  const grande = srv2.get('srcapas/bacaxa/' + KE).concat([{ id: 'grande', data: '2026-10-06', obs: 'y'.repeat(300 * 1024) }]);
  srv2.set('srcapas/bacaxa/' + KE, grande, 'outro'); await espera(900);
  const aviso2 = await B.ev(() => document.getElementById('notif').textContent), st2 = await B.ev(() => document.getElementById('sync-status').textContent);
  ok('navegador sem espaço ao receber: aviso na tela', /Memória do navegador cheia/.test(aviso2) && /sem espaço/.test(st2), { aviso2: aviso2.slice(0, 80), st2 });
  await B.fechar();
});

T('R9', 'versão antiga em outro computador', async (browser, ok) => {
  if (!ANTIGO) return ok('versão antiga disponível no Git', false);
  const srv = new Servidor(); srv.raiz = base();
  srv.raiz.srcapas.bacaxa.srcapas_custos_tpl_bacaxa = [{ id: 't1', cat: 'FIXO', nome: 'Aluguel', val: 100, diaVenc: 5, forma: 'PIX', ativo: true }];
  const V = await abrirCliente(browser, srv, 'V-antigo', ANTIGO); await espera(600);
  await V.ev(() => changeEmpresa('araruama')); await espera(600);
  await lancar(V, 'x1'); await espera(300);
  const N = await abrirCliente(browser, srv, 'N-novo', NOVO); await espera(600);
  for (let i = 1; i <= 8; i++) { await lancar(N, 'n' + i); await espera(60); }
  await espera(3600);
  await V.ev(() => setTab('verificacao')); await V.ev(() => changeEmpresa('bacaxa')); await espera(1500);
  const aviso = await N.ev(() => document.getElementById('notif').textContent);
  ok('o que a versão antiga apagou fica guardado, com aviso na tela', resgatados(srv).filter(x => /^n\d$/.test(x)).length === 8 && /sumiram/.test(aviso), { resgate: resgatados(srv).join(','), servidor: ids(srv.get('srcapas/bacaxa/' + KE)) });
  await V.fechar(); await N.fechar();
});

T('R10', 'regras de conflito da mescla', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO), B = await abrirCliente(browser, srv, 'B', NOVO); await espera(700);
  const r = await A.ev(() => {
    const b = [{ id: 1, v: 1, o: 'x' }, { id: 2, v: 2 }], j = JSON.stringify;
    const conta = f => { _mi = { mantidos: 0, sobrepostos: 0 }; const v = f(); const c = _mi; _mi = null; return [j(v), c.mantidos, c.sobrepostos]; };
    return {
      apagoAqui_intactoLa: conta(() => _merge3(b, [{ id: 2, v: 2 }], b)),
      apagoAqui_editamLa: conta(() => _merge3(b, [{ id: 2, v: 2 }], [{ id: 1, v: 99, o: 'x' }, { id: 2, v: 2 }])),
      editoAqui_apagamLa: conta(() => _merge3(b, [{ id: 1, v: 50, o: 'x' }, { id: 2, v: 2 }], [{ id: 2, v: 2 }])),
      mesmoCampo: conta(() => _merge3(b, [{ id: 1, v: 10, o: 'x' }, { id: 2, v: 2 }], [{ id: 1, v: 20, o: 'x' }, { id: 2, v: 2 }])),
      listaComoObjeto: j(_merge3(b, b.concat([{ id: 3, v: 3 }]), { 0: { id: 1, v: 1, o: 'x' }, 1: { id: 2, v: 2 }, 5: { id: 9, v: 9 } })),
    };
  });
  ok('apagar aqui algo intacto lá: apaga', r.apagoAqui_intactoLa[0] === '[{"id":2,"v":2}]');
  ok('apagar aqui algo que editaram lá: mantém o editado e conta o conflito', r.apagoAqui_editamLa[0] === '[{"id":1,"v":99,"o":"x"},{"id":2,"v":2}]' && r.apagoAqui_editamLa[1] === 1, r.apagoAqui_editamLa);
  ok('editar aqui algo que apagaram lá: mantém o editado e conta o conflito', /"v":50/.test(r.editoAqui_apagamLa[0]) && r.editoAqui_apagamLa[1] === 1, r.editoAqui_apagamLa);
  ok('mesmo campo dos dois lados: vale o local e conta o conflito', /"v":10/.test(r.mesmoCampo[0]) && r.mesmoCampo[2] === 1, r.mesmoCampo);
  ok('lista devolvida como objeto é mesclada sem perder registros', ['"id":1', '"id":2', '"id":3', '"id":9'].every(x => r.listaComoObjeto.includes(x)), r.listaComoObjeto);
  // na prática: os dois editam o mesmo campo ao mesmo tempo -> aviso na tela de quem enviou por último
  A.desconectar(); await espera(100);
  await A.ev(() => { const a = load('entradas'); a.find(x => x.id === 'e1').din = 111; save('entradas', a); });
  await B.ev(() => { const a = load('entradas'); a.find(x => x.id === 'e1').din = 222; save('entradas', a); }); await espera(600);
  A.conectar(); await espera(1500);
  const aviso = await A.ev(() => document.getElementById('notif').textContent);
  ok('conflito real gera aviso na tela', /Outra pessoa alterou/.test(aviso) && srv.get('srcapas/bacaxa/' + KE).find(x => x.id === 'e1').din === 111, aviso.slice(0, 90));
  await A.fechar(); await B.fechar();
});

T('REAL', 'navegação completa contra cópia do banco real (opcional: BACKUP_JSON)', async (browser, ok) => {
  const arq = process.env.BACKUP_JSON;
  if (!arq || !fs.existsSync(arq)) { console.log('   (pulado: defina BACKUP_JSON=/caminho/do/export.json)'); return; }
  const real = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const srv = new Servidor(); srv.raiz = JSON.parse(JSON.stringify(real));
  const antes = {}; for (const l of Object.keys(real.srcapas)) for (const k of Object.keys(real.srcapas[l])) antes[l + '/' + k] = canon(real.srcapas[l][k]);
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(1500);
  const tabs = await A.ev(() => Object.keys(TITLES));
  for (const loja of Object.keys(real.srcapas)) {
    await A.ev(l => { document.getElementById('empresa-sel').value = l; changeEmpresa(l); }, loja); await espera(1200);
    for (const mes of [8, 9, 10]) { await A.ev(m => { document.getElementById('sel-mes').value = m; changePeriod(); }, mes); await espera(250);
      for (const t of tabs) { await A.ev(t => setTab(t), t); await espera(120); } }
  }
  await espera(2500);
  const sumiram = Object.keys(antes).filter(x => { const [l, k] = x.split('/'); return srv.raiz.srcapas[l][k] === undefined; });
  const mudaram = Object.keys(antes).filter(x => { const [l, k] = x.split('/'); return k !== '_ts' && srv.raiz.srcapas[l][k] !== undefined && canon(srv.raiz.srcapas[l][k]) !== antes[x] && !/verif_custos/.test(k); });
  ok('nenhuma chave some e nada muda além dos custos recorrentes gerados', sumiram.length === 0 && mudaram.length === 0, { sumiram, mudaram });
  ok('sem pendências, sem resgate, sem erros', (await A.ev(() => _contarPend())) === 0 && !srv.raiz.srcapas_resgate && semRede(A).length === 0, { erros: semRede(A).slice(0, 3), resgate: Object.keys(srv.raiz.srcapas_resgate || {}) });
  await A.fechar();
});

const comConta = (srv, usuario, uid, pw) => { srv.contas[usuario + '@mrcapas.local'] = { pw, uid }; };
const telas = c => c.ev(() => ({ login: getComputedStyle(document.getElementById('login-screen')).display, app: getComputedStyle(document.getElementById('app')).display, msg: document.getElementById('l-err').textContent }));
const entrar = async (c, u, p) => { await c.ev(([u, p]) => { document.getElementById('l-user').value = u; document.getElementById('l-pass').value = p; doLogin(); }, [u, p]); await espera(700); };

T('R11', 'login real: sem senha no código; só entra quem está cadastrado', async (browser, ok) => {
  ok('o arquivo não tem senha nem lista de usuários escrita', !/CREDS/.test(NOVO) && !/srcapas_auth/.test(NOVO));
  const srv = new Servidor(); srv.raiz = base();
  srv.raiz.usuarios = { ADM: { nome: 'Admin', perfil: 'admin' }, TEC: { nome: 'Emerson', perfil: 'tecnico' } };
  comConta(srv, 'admin', 'ADM', 'certa'); comConta(srv, 'emerson', 'TEC', 'tec1'); comConta(srv, 'novo', 'NOVO', 'n1');
  const A = await abrirCliente(browser, srv, 'A', NOVO, { semLogin: true, semUsuario: true }); await espera(800);
  let t = await telas(A);
  ok('sem login: só a tela de login aparece', t.login !== 'none' && t.app === 'none', t);
  ok('sem login: nenhum dado das lojas é lido', !srv.leituras.some(p => p.indexOf('srcapas') === 0), srv.leituras);
  await entrar(A, 'Admin', 'errada'); t = await telas(A);
  ok('senha errada: mostra o erro e continua fora', t.app === 'none' && /incorretos/.test(t.msg), t);
  await entrar(A, 'emerson', 'tec1'); t = await telas(A);
  ok('perfil técnico não entra no sistema principal', t.app === 'none' && /não tem acesso/.test(t.msg) && (await A.ev(() => window.__fbSaiu)) >= 1, t);
  await entrar(A, 'novo', 'n1'); t = await telas(A);
  ok('conta sem cadastro de permissão não entra', t.app === 'none' && /sem permissão/.test(t.msg), t);
  ok('nada de lojas foi lido por quem não entrou', !srv.leituras.some(p => p.indexOf('srcapas') === 0), srv.leituras);
  await entrar(A, 'Admin', 'certa'); await espera(600); t = await telas(A);
  const u = await A.ev(() => window._USER);
  ok('admin com a senha certa entra', t.app !== 'none' && t.login === 'none' && u && u.perfil === 'admin', { t, u });
  ok('depois de entrar a loja é lida', srv.leituras.some(p => p.indexOf('srcapas/') === 0));
  await A.fechar();
});

T('R12', 'perfil "completo" só enxerga as lojas liberadas', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const C = await abrirCliente(browser, srv, 'C', NOVO, { uid: 'C1', perfil: { nome: 'Paiva', perfil: 'completo', lojas: { araruama: true } } }); await espera(1200);
  const e = await C.ev(() => ({ emp: ST.empresa, bloqueadas: Array.from(document.querySelectorAll('#empresa-sel option')).filter(o => o.disabled).map(o => o.value) }));
  ok('abre na loja liberada e esconde as outras', e.emp === 'araruama' && e.bloqueadas.indexOf('bacaxa') >= 0 && e.bloqueadas.indexOf('araruama') < 0, e);
  await lancar(C, 'p1'); await espera(900);
  ok('não lê nem grava em loja não liberada', !srv.leituras.some(p => p.indexOf('srcapas/bacaxa') === 0) && !srv.log.some(l => l.p.indexOf('srcapas/bacaxa') === 0), { leituras: srv.leituras, log: srv.log.map(l => l.p) });
  ok('o lançamento da loja liberada chega ao servidor', JSON.stringify(srv.get('srcapas/araruama')).includes('p1'));
  await C.fechar();
});

T('R15', 'permissões por aba: esconde, deixa só ler, e só o admin vê "Acessos"', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const C = await abrirCliente(browser, srv, 'C', NOVO, { uid: 'C1', perfil: { nome: 'Paiva', perfil: 'completo', lojas: { bacaxa: true }, abas: { entradas: 'ver', saidas: 'editar', financeiras: 'ver' } } }); await espera(1200);
  const e = await C.ev(() => ({ tab: ST.tab, vis: Array.from(document.querySelectorAll('.sb-item[data-tab]')).filter(b => b.style.display !== 'none').map(b => b.dataset.tab), desab: document.querySelectorAll('#content input:disabled,#content button:disabled').length, aviso: document.getElementById('content').innerText.includes('Somente leitura') }));
  ok('mostra só as abas liberadas (sem Acessos)', JSON.stringify(e.vis.sort()) === JSON.stringify(['entradas', 'financeiras', 'saidas']), e);
  ok('aba "só ver" abre travada com aviso', e.tab === 'entradas' && e.desab > 0 && e.aviso, e);
  const fin = await C.ev(async () => { ST.tab = 'financeiras'; render(); await new Promise(r => setTimeout(r, 100)); const bt = Array.from(document.querySelectorAll('#content .tab-btn')); const off = bt.filter(b => b.disabled).length; if (bt[1]) bt[1].click(); await new Promise(r => setTimeout(r, 150)); const bt2 = Array.from(document.querySelectorAll('#content .tab-btn')); return { n: bt.length, off, ativo: finTab, off2: bt2.filter(b => b.disabled).length, travados: document.querySelectorAll('#content input:disabled').length }; });
  ok('"só ver": troca de financeira continua funcionando', fin.n > 1 && fin.off === 0 && fin.ativo === 1 && fin.off2 === 0, fin);
  const e2 = await C.ev(() => { setTab('dre', null); return ST.tab; });
  ok('aba não liberada não abre', e2 !== 'dre', e2);
  const e3 = await C.ev(() => { setTab('saidas', document.querySelector('[data-tab=saidas]')); return { tab: ST.tab, desab: document.querySelectorAll('#content input:disabled').length }; });
  ok('aba "editar" abre normal', e3.tab === 'saidas' && e3.desab === 0, e3);
  await C.fechar();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(1200);
  const a = await A.ev(() => ({ acessos: document.querySelector('[data-tab=acessos]').style.display, todas: Array.from(document.querySelectorAll('.sb-item[data-tab]')).filter(b => b.style.display === 'none').length }));
  ok('administrador vê todas as abas e Acessos', a.acessos !== 'none' && a.todas === 0, a);
  await A.ev(() => setTab('acessos', document.querySelector('[data-tab=acessos]'))); await espera(800);
  const l = await A.ev(() => document.getElementById('content').innerText);
  ok('página Acessos lista os usuários e o formulário de novo', l.toLowerCase().includes('novo usuário') && l.toLowerCase().includes('teste'), l.slice(0, 200));
  await A.fechar();
});

T('R16', 'manutenção: 50% do lucro, semana sáb→sex, pagar semana cria a Saída (e desfazer remove)', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(1200);
  const d = await A.ev(() => ({ sab: manutSexta('2026-09-26'), dom: manutSexta('2026-09-27'), seg: manutSexta('2026-09-28'), sex: manutSexta('2026-10-02'), tec: manutTec({ valor: 240, peca: 11.4 }), lucro: manutLucro({ valor: 350, peca: 85 }) }));
  ok('sábado e domingo vão para a sexta seguinte; sexta fica na própria', d.sab === '2026-10-02' && d.dom === '2026-10-02' && d.seg === '2026-10-02' && d.sex === '2026-10-02', d);
  ok('técnico recebe 50% do lucro (valor − peça)', d.tec === 114.3 && d.lucro === 265, d);
  const r = await A.ev(async () => {
    const hoje = new Date(); ST.ano = hoje.getFullYear(); ST.mes = hoje.getMonth() + 1; ST.tab = 'manutencao'; render();
    const dt = today();
    document.getElementById('m-dt').value = dt; document.getElementById('m-cli').value = 'Fulano'; document.getElementById('m-srv').value = 'troca de tela';
    document.getElementById('m-val').value = '300'; document.getElementById('m-peca').value = '100'; addManut();
    const sx = manutSexta(dt); const antes = { n: load('manut').length, pago: !!_manutPago(sx) };
    pagarSemanaManut(sx, 100, 0);
    const saida = load('saidas').filter(x => x.manutSexta === sx);
    const depois = !!_manutPago(sx);
    const bloq = (function(){ const n = load('manut').length; document.getElementById('m-cli').value = 'Outro'; document.getElementById('m-srv').value = 'x'; document.getElementById('m-val').value = '50'; addManut(); return load('manut').length === n; })();
    const bt = document.querySelector('[id^=mp-d]'); if (bt) { bt.click(); bt.click(); }
    return { antes, saida: saida.map(x => ({ cat: x.cat, val: x.val })), depois, bloq, desfeito: !_manutPago(sx), saidaSumiu: load('saidas').filter(x => x.manutSexta === sx).length === 0 };
  });
  ok('registrou o serviço e a semana estava pendente', r.antes.n === 1 && !r.antes.pago, r);
  ok('pagar semana cria 1 Saída "Pessoal" de R$ 100 e marca como paga', r.saida.length === 1 && r.saida[0].cat === 'Pessoal' && r.saida[0].val === 100 && r.depois, r);
  ok('semana paga não aceita novo serviço', r.bloq, r);
  ok('desfazer remove o pagamento e a Saída', r.desfeito && r.saidaSumiu, r);
  await A.fechar();
});

T('R17', 'página do técnico: lança por loja, vê total da semana, não altera semana paga', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const T = await abrirCliente(browser, srv, 'T', TEC, { uid: 'T1', perfil: { nome: 'Emerson', perfil: 'tecnico', lojas: { bacaxa: true, araruama: true } }, url: 'https://www.mrcapas.com.br/tecnico-teste/' }); await espera(1500);
  const a = await T.ev(() => ({ app: document.getElementById('app').style.display, lojas: Array.from(document.querySelectorAll('#f-loja option')).map(o => o.value) }));
  ok('técnico entra e só vê as lojas dele', a.app === 'block' && JSON.stringify(a.lojas) === JSON.stringify(['bacaxa', 'araruama']), a);
  const r = await T.ev(async () => {
    const dt = hojeISO(); const sx = sexta(dt);
    const pre = (l) => { document.getElementById('f-loja').value = l; document.getElementById('f-data').value = dt; document.getElementById('f-cli').value = 'Maria Silva'; document.getElementById('f-srv').value = 'troca de tela'; document.getElementById('f-val').value = '300'; document.getElementById('f-peca').value = '100'; };
    pre('bacaxa'); adicionar(); await new Promise(r => setTimeout(r, 700));
    pre('araruama'); adicionar(); await new Promise(r => setTimeout(r, 700));
    return { total: document.getElementById('k-total').textContent.replace(/\s/g, ' '), qtd: document.getElementById('k-qtd').textContent, linhas: document.querySelectorAll('#lista tr').length, sx };
  });
  ok('lançou em duas lojas; total da semana soma R$ 100 + R$ 100', /200,00/.test(r.total) && r.qtd === '2' && r.linhas === 2, r);
  const noServ = JSON.stringify(srv.get('srcapas'));
  ok('cada serviço foi gravado na loja certa', JSON.stringify(srv.get('srcapas/bacaxa')).includes('Maria Silva') && JSON.stringify(srv.get('srcapas/araruama')).includes('Maria Silva'), noServ.slice(0, 200));
  // semana paga: bloqueia
  const d = new Date(), mm = d.getFullYear() + '_' + String(d.getMonth() + 1).padStart(2, '0');
  const sx = r.sx, mp = sx.slice(0, 4) + '_' + sx.slice(5, 7);
  srv.set('srcapas/bacaxa/srcapas_manutpag_bacaxa_' + mp, [{ id: 'p1', sexta: sx, valor: 100, pagoEm: sx }], 'admin');
  const b = await T.ev(async () => { await carregar(); const n0 = DADOS.length; document.getElementById('f-loja').value = 'bacaxa'; document.getElementById('f-data').value = hojeISO(); document.getElementById('f-cli').value = 'X'; document.getElementById('f-srv').value = 'y'; document.getElementById('f-val').value = '50'; adicionar(); await new Promise(r => setTimeout(r, 500)); await carregar(); return { n0, n1: DADOS.length, pago: document.getElementById('lista').innerText.includes('pago'), msg: document.getElementById('msg').textContent }; });
  ok('semana já paga: não aceita novo serviço e mostra "pago"', b.n0 === b.n1 && b.pago && /já foi pago/.test(b.msg), b);
  await T.fechar();
  const N = await abrirCliente(browser, srv, 'N', TEC, { uid: 'C9', perfil: { nome: 'Paiva', perfil: 'completo', lojas: { bacaxa: true } }, url: 'https://www.mrcapas.com.br/tecnico-teste/' }); await espera(1200);
  const n = await N.ev(() => ({ app: document.getElementById('app').style.display, erro: document.getElementById('l-err').textContent }));
  ok('perfil que não é técnico/admin não entra na página do técnico', n.app === 'none' && /não tem acesso/.test(n.erro), n);
  await N.fechar();
});

T('R13', 'sair: envia o pendente e volta para a tela de login', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO); await espera(1000);
  await lancar(A, 'antesDeSair'); await A.ev(() => doLogout()); await espera(2000);
  const t = await telas(A);
  ok('volta para o login depois de sair', t.login !== 'none' && t.app === 'none', t);
  ok('o que foi lançado antes de sair está no servidor', JSON.stringify(srv.get('srcapas/bacaxa')).includes('antesDeSair'));
  await A.fechar();
});

T('R14', 'sem internet: aparelho que já entrou abre; o primeiro acesso exige internet', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const A = await abrirCliente(browser, srv, 'A', NOVO, { offline: true, localInicial: { [PFX + 'mrc_perfil:U']: JSON.stringify({ nome: 'Teste', perfil: 'admin' }) } }); await espera(4000);
  let t = await telas(A);
  ok('com o perfil guardado, abre mesmo sem internet', t.app !== 'none' && t.login === 'none', t);
  A.conectar(); await espera(1500);
  ok('ao voltar a internet, o perfil guardado é confirmado e continua dentro', (await telas(A)).app !== 'none' && JSON.parse(await A.ev(() => localStorage.getItem('mrc_perfil:U'))).perfil === 'admin');
  srv.raiz.usuarios.U = { nome: 'Teste', perfil: 'tecnico' }; // acesso revogado no servidor
  await A.page.reload({ waitUntil: 'load' }); await espera(1800); t = await telas(A);
  ok('acesso revogado no servidor: não entra mais', t.app === 'none' && /não tem acesso/.test(t.msg), t);
  await A.fechar();
  const B = await abrirCliente(browser, srv, 'B', NOVO, { offline: true, uid: 'SEM_CACHE', semUsuario: true }); await espera(4000);
  t = await telas(B);
  ok('primeiro acesso sem internet: não entra', t.app === 'none', t);
  await B.fechar();
});

(async () => {
  const filtro = process.argv.slice(2);
  const browser = await chromium.launch();
  let passou = 0, falhou = 0;
  for (const t of testes) {
    if (filtro.length && !filtro.some(f => t.cod.toUpperCase().startsWith(f.toUpperCase()))) continue;
    console.log(t.cod + ' — ' + t.nome);
    const ok = (nome, cond, det) => { if (cond) { passou++; console.log('   PASSOU  ' + nome); } else { falhou++; console.log('   FALHOU  ' + nome + (det !== undefined ? '  ' + JSON.stringify(det) : '')); } };
    try { await t.fn(browser, ok); } catch (e) { falhou++; console.log('   ERRO    ' + (e && e.stack || e)); }
    for (const c of browser.contexts()) await c.close().catch(() => {});
  }
  await browser.close();
  console.log('\n' + passou + ' de ' + (passou + falhou) + ' verificações passaram');
  process.exit(falhou ? 1 : 0);
})();
