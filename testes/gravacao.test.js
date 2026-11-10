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

T('T12', 'teste e oficial no mesmo navegador', async (browser, ok) => {
  const srv = new Servidor(); srv.raiz = base();
  const P = await abrirCliente(browser, srv, 'P', NOVO); await espera(700);
  const Tt = await abrirCliente(browser, srv, 'T', NOVO, { ctx: P.ctx, url: 'https://www.mrcapas.com.br/financeiro-teste/' }); await espera(900);
  const vazio = ((await Tt.local(KE)) || []).length;
  await lancar(Tt, 'FALSO1'); await Tt.ev(() => changeEmpresa('araruama')); await espera(700);
  await lancar(Tt, 'FALSO3'); await espera(800);
  await P.page.reload({ waitUntil: 'load' }); await espera(1200);
  await P.ev(() => changeEmpresa('araruama')); await espera(900);
  await lancar(P, 'realNovo'); await espera(900);
  const real = JSON.stringify(srv.get('srcapas')), teste = JSON.stringify(srv.get('srcapas_teste') || {});
  ok('não se misturam', (await Tt.ev(() => _RAIZ)) === 'srcapas_teste' && vazio === 0 && !real.includes('FALSO') && real.includes('realNovo') && teste.includes('FALSO1') && teste.includes('FALSO3') && !teste.includes('"e1"') && !teste.includes('realNovo') && (await P.ev(() => _contarPend())) === 0);
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
