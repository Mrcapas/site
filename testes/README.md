# Testes da gravação do financeiro

Rodam a página real (`financeiro/index.html`) no Chromium contra um Firebase falso que vive
no próprio teste. Nenhum teste toca no Firebase de verdade nem em dados reais.

## Rodar

```
npm install playwright     # uma vez
npx playwright install chromium
node testes/gravacao.test.js
```

- `node testes/gravacao.test.js R1 R3` roda só os testes cujo código começa com `R1` ou `R3`.
- `BACKUP_JSON=/caminho/export.json node testes/gravacao.test.js REAL` navega pelas 3 lojas,
  3 meses e todas as abas contra uma cópia do banco exportada do console do Firebase.
  O arquivo de backup **não** deve ser colocado no repositório.
- `PAGINA=/caminho/outro.html node testes/gravacao.test.js` roda os mesmos testes contra
  outra versão da página.

A versão antiga da página, usada nos testes de convivência, é lida do histórico do Git
(commit `46671b8`); por isso os testes precisam rodar dentro do repositório.

## O que cada teste cobre

| Código | Cenário |
| --- | --- |
| T1 | A perda original: a versão antiga apaga a loja ao trocar de loja na Verificação; a nova não |
| T2 | Dois computadores na mesma loja: lançamentos simultâneos, exclusão, edições, campos nulos |
| T5 | Abrir sem internet, lançar e reconectar |
| T7 | Cópias de outras lojas dentro do nó; lançar e trocar de loja em seguida |
| T8 | Dados que a versão antiga deixou no navegador: não entram sozinhos, vão para o resgate |
| T12 | Página de teste e página oficial no mesmo navegador |
| R1 | Aba da versão antiga (ou a página da raiz) aberta no mesmo navegador que a nova |
| R2 | Recarregar com envio pendente enquanto outro usuário apaga e edita |
| R3 | Duas abas da versão nova no mesmo navegador |
| R4 | Nome de campo que o Firebase não aceita; exceção na hora do envio |
| R5 | Rede de segurança: sem teto, objetos sem `id`, só some depois de confirmada |
| R7 | Pendência de uma loja que não é reaberta |
| R8 | Loja fora da lista; navegador sem espaço ao receber dados |
| R9 | Versão antiga em outro computador apagando a loja |
| R10 | Regras de conflito da mescla e aviso na tela |
| REAL | Navegação completa contra cópia do banco real (opcional) |

## Arquivos

- `gravacao.test.js` — os testes.
- `apoio.js` — o servidor falso (em memória) e a abertura das páginas.
- `firebase-falso.js` — substituto do SDK do Firebase carregado pela página durante o teste.
