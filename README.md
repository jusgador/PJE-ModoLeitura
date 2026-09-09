# PJE-ModoLeitura

Userscript (Tampermonkey) que lê a **minuta do PJe** (despacho, decisão, sentença) em um
**overlay de tela cheia** com coluna estreita, fonte grande e temas de leitura — em vez de
ler o texto apertado dentro do editor do sistema.

- Alvo: `pje1g.trf5.jus.br` e `pje2g.trf5.jus.br` (TRF5, 1º e 2º graus)
- Versão atual: **0.4.5**
- Arquivo: [`pje-minuta-modo-leitura.user.js`](pje-minuta-modo-leitura.user.js)

> **Atualização automática:** o script tem `@updateURL`/`@downloadURL` apontando para o
> [`raw.githubusercontent.com/jusgador/PJE-ModoLeitura/main/...`](https://raw.githubusercontent.com/jusgador/PJE-ModoLeitura/main/pje-minuta-modo-leitura.user.js).
> Para que o Tampermonkey acompanhe as versões, **instale-o a partir da URL** (passo 2 abaixo)
> em vez de criar um script colando o código. Com isso, a cada novo `@version` na `main` ele
> atualiza sozinho.

## Instalação

1. Instale a extensão **Tampermonkey** no navegador.
2. Abra o arquivo `pje-minuta-modo-leitura.user.js` (ou cole o conteúdo em
   *Tampermonkey → Painel → + → Criar novo script*, substituindo o modelo).
3. Salve (`Ctrl+S`). O script passa a valer nos domínios do PJe após recarregar a página.

## Uso

| Ação | Como |
| --- | --- |
| Abrir o modo leitura | `Alt+L` ou o botão flutuante no canto da tela |
| Fechar | `Esc` ou o botão de fechar do overlay |
| Alternar largura da coluna | tecla `W` (760 / 900 / 1100 / 1400 / tela toda) |
| Alternar tema | tecla `T` (claro / sépia / escuro) |
| Ajustar tamanho da fonte | controles do overlay |
| Copiar o texto | botão **Copiar** |
| Imprimir | botão **Imprimir** |

A abertura automática (quando uma minuta é detectada) pode ser desligada — a preferência
fica em `localStorage` na chave `pjeMinutaModoLeitura.cfg`.

## Como funciona (resumo)

A minuta **não** fica na página principal do PJe. A cadeia de frames é:

```
pje1g.trf5.jus.br/pje/ng2/dev.seam            (frame de topo)
  └─ iframe #ngFrame  -> frontend-prd.trf5.jus.br   (painel Angular)
       └─ iframe      -> pje1g.trf5.jus.br/pje/Processo/movimentar.seam
                          ^ é AQUI que vive o texto da minuta
```

1. O script roda em **todos** os frames que casam com `@match` (sem `@noframes`).
2. O frame que contém a minuta extrai o texto e o envia por `postMessage` para a janela
   de topo, que desenha o overlay — assim a leitura ocupa a janela inteira.
3. Se a minuta for aberta em aba própria (janela de topo), o overlay é desenhado localmente.
4. **Ordem de extração:** CKEditor (edição) → `contenteditable` → iframes internos →
   seletores conhecidos de visualização → maior bloco de texto da página (visualização).

### Detalhe crítico: `@grant none`

O editor estruturado do PJe (**Bernoulli Documentos**, `bd-*`/ProseMirror) pode criar o
conteúdo dentro de um **ShadowRoot fechado**, invisível para `querySelectorAll`/`innerText`.
Para capturá-lo o script embrulha `Element.prototype.attachShadow` **no realm da página** —
e isso só funciona com `@grant none`. Com qualquer `@grant` o Tampermonkey roda o script num
sandbox (mundo isolado) e o patch não vale para o código da página.

Consequência: **não existem** `GM_addStyle`/`GM_registerMenuCommand`. O CSS é injetado por
`<style>` e o menu do Tampermonkey fica sem atalhos (o botão flutuante e o `Alt+L` continuam
funcionando). O patch apenas **observa**: o comportamento da página não muda.

## Estrutura

```
pje-minuta-modo-leitura.user.js   # o userscript (instalar este)
tools/pje-minuta-dump-dom.js      # diagnóstico: onde o texto da minuta mora no DOM
README.md
```

`tools/pje-minuta-dump-dom.js` é um utilitário de desenvolvimento: rodado no console do
frame `movimentar.seam` (modo edição), procura frases marcantes da minuta em todo o
documento — inclusive dentro de shadow roots abertos — e informa exatamente onde ela está.
Não altera nada; só lê. Ajuste o array `FRASES` para a sua minuta.

## Desenvolvimento

- Linguagem: JavaScript puro, arquivo único, sem build e sem dependências.
- Ao alterar o script, incremente `@version` no cabeçalho (o Tampermonkey usa isso para
  detectar atualização) e recarregue a página do PJe.
- Depuração: como o script roda no contexto da página, o console do DevTools mostra os
  logs do próprio script; lembre-se de selecionar o frame correto no seletor de contexto
  do console (o texto vive no frame `movimentar.seam`).
- Não use `@noframes` — quebraria a detecção nos frames internos.

## Limitações conhecidas

- Seletores do editor do PJe mudam com atualizações do sistema; a extração tem heurísticas
  de fallback justamente por isso.
- O overlay não edita a minuta: é somente leitura, cópia e impressão.
