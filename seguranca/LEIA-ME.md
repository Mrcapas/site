# Segurança — passo 1 (login real + regras por loja)

- `regras-passo1.json`: regras do Realtime Database. Quem não está logado não lê nem grava nada.
  Cada usuário tem um cadastro em `/usuarios/<uid>` com `nome` e `perfil`:
  - `admin`: acesso total (inclusive a `/usuarios`).
  - `completo`: acesso às lojas marcadas em `lojas` (ex.: `"lojas": { "araruama": true }`).
  - `tecnico`: não entra no sistema principal (a página própria do técnico vem depois).
- Os cadastros são criados à mão no console do Firebase (Realtime Database → Dados). O console não passa pelas regras.
- O login usa o Firebase Authentication com e-mails internos `<usuario>@mrcapas.local`; nenhuma senha fica no código.
- Testes: `PAGINA=$PWD/financeiro-teste/index.html node testes/gravacao.test.js` (61 verificações, Firebase simulado).
