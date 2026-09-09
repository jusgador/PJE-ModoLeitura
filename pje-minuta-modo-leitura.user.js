// ==UserScript==
// @name         PJe - Minuta em modo leitura (overlay tela cheia)
// @namespace    pje.minuta.modo-leitura
// @version      0.4.5
// @description  Detecta o texto da minuta (despacho/decisão/sentença) na tela de elaboração do PJe — editor Bernoulli Documentos (bd-*/ProseMirror, inclusive dentro de ShadowRoot fechado), CKEditor ou modo visualização — e exibe em um overlay de leitura em tela cheia: coluna estreita, fonte grande, temas claro/sépia/escuro, ajuste de fonte e largura, copiar e imprimir.
// @author       Ricardo
// @match        https://pje1g.trf5.jus.br/pje/*
// @match        https://pje2g.trf5.jus.br/pje/*
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/jusgador/PJE-ModoLeitura/main/pje-minuta-modo-leitura.user.js
// @downloadURL  https://raw.githubusercontent.com/jusgador/PJE-ModoLeitura/main/pje-minuta-modo-leitura.user.js
// @grant        none
// ==/UserScript==

/*
 * ATENÇÃO ao @grant none: é de propósito.
 * Para capturar um ShadowRoot FECHADO é preciso embrulhar
 * Element.prototype.attachShadow NO REALM DA PÁGINA. Com qualquer @grant
 * o Tampermonkey roda o script num sandbox (mundo isolado) e o patch não
 * vale para o código da página. Com @grant none o script roda no contexto
 * da página, então NÃO existem GM_addStyle/GM_registerMenuCommand — o CSS
 * é injetado por <style> e o menu do Tampermonkey fica sem atalhos (o
 * botão flutuante e o Alt+L continuam funcionando).
 */

/*
 * COMO FUNCIONA (importante)
 * 1) A minuta NÃO fica na página principal do PJe. A cadeia é:
 *      pje1g.trf5.jus.br/pje/ng2/dev.seam            (frame de topo)
 *        └─ iframe #ngFrame  -> frontend-prd.trf5.jus.br   (painel Angular)
 *             └─ iframe      -> pje1g.trf5.jus.br/pje/Processo/movimentar.seam
 *                                ^ é AQUI que vive o texto da minuta
 *    Por isso o @match é em pje1g/pje2g: o Tampermonkey roda o script em
 *    TODOS os frames cuja URL casa (não use @noframes).
 *
 * 2) O frame que contém a minuta extrai o texto e o envia por postMessage
 *    para a janela de topo, que é quem desenha o overlay. Assim a leitura
 *    ocupa a janela inteira, e não só o pedacinho do iframe.
 *
 * 3) Se a minuta for aberta em aba própria (janela de topo), o overlay é
 *    desenhado localmente.
 *
 * 4) Extração (em ordem): CKEditor (edição) -> contenteditable ->
 *    iframes internos -> seletores conhecidos de visualização ->
 *    maior bloco de texto da página (visualização).
 */

(function () {
    'use strict';

    /* ============================================================
       1. CONFIGURAÇÃO
       ============================================================ */
    const PADRAO = {
        autoAbrir: true,      // abrir sozinho quando detectar uma minuta
        tema: 'sepia',        // claro | sepia | escuro
        fonte: 20,            // px
        largura: 900,         // px da coluna de texto
        entrelinha: 1.65,
    };
    const TEMAS = ['claro', 'sepia', 'escuro'];
    const LARGURAS = [760, 900, 1100, 1400, 0]; // 0 = largura total
    const CHAVE_CFG = 'pjeMinutaModoLeitura.cfg';
    const CHAVE_ABRIU = 'pjeMinutaModoLeitura.jaAbriu';

    const cfg = Object.assign({}, PADRAO, lerJSON(CHAVE_CFG) || {});

    const ESTOU_NO_TOPO = (() => { try { return window.top === window; } catch (e) { return true; } })();

    /* ============================================================
       1.1 CAPTURA DE SHADOW ROOTS
       O editor estruturado do PJe (Bernoulli Documentos) pode criar o seu
       conteúdo dentro de um ShadowRoot FECHADO — invisível para
       querySelectorAll/innerText. Como o script roda em document-start,
       dá para guardar a referência no momento em que o ShadowRoot nasce.
       O patch só OBSERVA: o comportamento da página não muda.
       ============================================================ */
    const sombrasCapturadas = [];

    // Quando um ShadowRoot nasce (o editor costuma montar o seu depois da
    // página carregar), agenda uma nova verificação — assim a minuta aparece
    // sem o usuário precisar apertar nada.
    let timerVerificar = null;
    function agendarVerificacao() {
        if (timerVerificar) return;
        timerVerificar = setTimeout(() => {
            timerVerificar = null;
            if (ESTOU_NO_TOPO) pedirMinuta();
            else {
                const m = extrairMinuta();
                if (m) enviarParaTopo(m);
            }
        }, 400);
    }

    // Aplica o patch em um realm (window). Necessário também no realm do
    // iframe#editorEstruturadoFrame, que é onde o editor costuma nascer.
    function patcharRealm(win) {
        try {
            if (!win || !win.Element || !win.Element.prototype.attachShadow) return;
            const proto = win.Element.prototype;
            if (proto.attachShadow.__pmlPatch) return;
            const original = proto.attachShadow;
            const novo = function (iniciais) {
                const raiz = original.call(this, iniciais);
                try { sombrasCapturadas.push(raiz); agendarVerificacao(); } catch (e) { }
                return raiz;
            };
            novo.__pmlPatch = true;
            proto.attachShadow = novo;
        } catch (e) { } // frame de outra origem
    }
    patcharRealm(window);

    function patcharFramesDoEditor() {
        for (const sel of SELETORES_IFRAME_EDITOR) {
            let frames = [];
            try { frames = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
            for (const f of frames) {
                try { patcharRealm(f.contentWindow); } catch (e) { }
            }
        }
    }

    // Shadow roots ABERTOS, em qualquer profundidade (o patch acima só pega os
    // criados depois dele; estes já existem e são acessíveis).
    function sombrasAbertas(raiz, saida) {
        let todos = [];
        try { todos = [...raiz.querySelectorAll('*')]; } catch (e) { return saida; }
        for (const el of todos) {
            if (!el.shadowRoot) continue;
            saida.push(el.shadowRoot);
            sombrasAbertas(el.shadowRoot, saida);
        }
        return saida;
    }

    function raizesDeShadow() {
        const conjunto = new Set(sombrasCapturadas);
        sombrasAbertas(document, []).forEach((r) => conjunto.add(r));
        for (const sel of SELETORES_IFRAME_EDITOR) {
            let frames = [];
            try { frames = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
            for (const f of frames) {
                let d = null;
                try { d = f.contentDocument; } catch (e) { continue; }
                if (d) sombrasAbertas(d, []).forEach((r) => conjunto.add(r));
            }
        }
        return [...conjunto];
    }

    /* ============================================================
       2. UTILIDADES
       ============================================================ */
    function lerJSON(chave) {
        try { return JSON.parse(localStorage.getItem(chave) || 'null'); } catch (e) { return null; }
    }
    function gravarJSON(chave, valor) {
        try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { }
    }
    function salvarCfg() { gravarJSON(CHAVE_CFG, cfg); }

    function descrever(el) {
        if (!el) return '?';
        const c = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : '');
    }

    // Texto puro do HTML. innerText NÃO serve aqui: no documento criado pelo
    // DOMParser não há layout, então blocos (<p>, <div>…) saem colados. Por
    // isso as quebras são marcadas no próprio HTML antes de extrair o texto.
    function textoDe(html) {
        const marcado = String(html || '')
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|td|th|table|ul|ol|pre)>/gi, '\n');
        let d;
        try { d = new DOMParser().parseFromString(marcado, 'text/html'); } catch (e) { return ''; }
        const bruto = (d.body && d.body.textContent) || '';
        return bruto
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function medir(html) { return textoDe(html).replace(/\s+/g, '').length; }

    // Elementos cujo textContent é CSS/JS, não conteúdo do documento. Sem isso
    // um <style> de 20 mil caracteres dentro de um shadow root vira "candidato
    // a minuta" e engana a descida até o miolo (ver candidatosDoShadow).
    const TAGS_NAO_TEXTO = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'TITLE']);
    function temTextoUtil(el) { return !!el && !TAGS_NAO_TEXTO.has(el.tagName); }

    // Medida BARATA para elementos do DOM (sem DOMParser). Usada para ordenar
    // candidatos; a medida exata (medir/textoDe) só roda no escolhido.
    function medirEl(el) {
        if (!temTextoUtil(el)) return 0;
        return (el.textContent || '').replace(/\s+/g, '').length;
    }

    // Indício de que ESTA página tem minuta/editor. Enquanto for false, o
    // script fica inerte (nenhuma varredura): importante para não pesar em
    // páginas como o Painel, que não têm minuta.
    // Também conta como pista: ShadowRoot capturado (o editor do PJe 2.x mora
    // dentro de um shadow fechado) e o documento de iframes alcançáveis
    // (o documento editado fica num iframe about:blank dentro desse shadow).
    const SELETOR_PISTA = '#appEditorAreaConteudoInner, .ProseMirror, .cke_editable, [contenteditable="true"], iframe#editorEstruturadoFrame, [id*=":minuta-"]';
    function temPistaDeEditor() {
        try {
            if (sombrasCapturadas.length > 0) return true;
            if (document.querySelector(SELETOR_PISTA)) return true;
            for (const f of todosOsIframes()) {
                let d = null;
                try { d = f.contentDocument; } catch (e) { continue; }
                if (d && d.querySelector(SELETOR_PISTA)) return true;
            }
            return false;
        } catch (e) { return false; }
    }

    // Nunca considerar o PRÓPRIO overlay (nem seus ancestrais) como candidato a
    // minuta — senão, ao reprocessar a página depois de aberto, o script
    // "encontra" o seu próprio texto e se renderiza dentro de si mesmo.
    function foraDoOverlay(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.id === 'pml-overlay') return false;
        if (el.closest && el.closest('#pml-overlay')) return false;
        if (el.querySelector && el.querySelector('#pml-overlay')) return false;
        return true;
    }

    /* ============================================================
       3. EXTRAÇÃO DO TEXTO DA MINUTA
       ============================================================ */

    // 3.1 Modo edição
    //  (a) editor Bernoulli Documentos (bd-*/ProseMirror) — inclusive dentro do
    //      iframe #editorEstruturadoFrame, onde o PJe 2.x hospeda o editor;
    //  (b) CKEditor 4 — PJe 1.x / outras telas;
    //  (c) contenteditable genérico.
    // O que o editor mostra agora ganha do "backup" que o PJe guarda em
    // [id*=":minuta-"] (esse só serve no modo visualização).
    const SELETORES_EDITOR_BD = [
        '#appEditorAreaConteudoInner',
        '.ProseMirror[contenteditable="true"]',
        '.ProseMirror',
        '.bd-ens',
        '[class*="bd-pages"]',
    ];
    const SELETORES_IFRAME_EDITOR = [
        'iframe#editorEstruturadoFrame',
        'iframe[id*="editor" i]',
        'iframe[src*="editor" i]',
        'iframe[src*="estruturado" i]',
    ];

    // Todos os iframes alcançáveis, inclusive os que vivem DENTRO de ShadowRoots
    // (fechados inclusive: as referências capturadas no document-start estão em
    // raizesDeShadow()). Verificado ao vivo no PJe 2.x: o editor (badon-writer)
    // monta o documento num iframe about:blank colocado dentro de um ShadowRoot
    // FECHADO (div#badon-writer-app-container) — invisível para o
    // document.querySelectorAll do frame que hospeda a tarefa. Como about:blank
    // herda a origem do pai, contentDocument é acessível; o userscript não roda
    // nesse iframe porque o @match não cobre about:blank.
    function iframesDe(raiz) {
        let achados = [];
        try { achados = [...raiz.querySelectorAll('iframe')]; } catch (e) { }
        return achados;
    }

    function todosOsIframes() {
        const conjunto = new Set(iframesDe(document));
        for (const raiz of raizesDeShadow()) iframesDe(raiz).forEach((f) => conjunto.add(f));
        return [...conjunto];
    }

    // Coleta TODOS os candidatos de um conjunto de seletores (ordenados do
    // maior para o menor). Devolver a lista — em vez do primeiro — é o que
    // permite descartar candidato que "não parece peça processual" e seguir
    // procurando (ver pareceDocumento).
    function candidatosDe(seletores, raiz, rotulo) {
        const achados = [];
        for (const sel of seletores) {
            let nos = [];
            try { nos = [...raiz.querySelectorAll(sel)]; } catch (e) { continue; }
            for (const el of nos) {
                if (!temTextoUtil(el) || !foraDoOverlay(el)) continue;
                const tamanho = medirEl(el);
                if (tamanho >= 200) achados.push({ html: el.innerHTML, origem: rotulo + ':' + sel, tamanho });
            }
        }
        return achados.sort((a, b) => b.tamanho - a.tamanho);
    }

    function candidatosDoEditor() {
        const achados = [];

        // (a) Bernoulli Documentos / ProseMirror neste documento
        achados.push(...candidatosDe(SELETORES_EDITOR_BD, document, 'editor'));

        // (a2) idem, dentro dos iframes alcançáveis — mesma origem, inclusive
        //      about:blank e inclusive iframes que vivem dentro de ShadowRoots
        //      fechados (é aí que o editor do PJe 2.x monta o documento).
        for (const f of todosOsIframes()) {
            let doc = null;
            try { doc = f.contentDocument; } catch (e) { continue; }
            if (!doc || !doc.body) continue;
            const dentro = candidatosDe(SELETORES_EDITOR_BD, doc, 'iframe-editor:' + descrever(f));
            if (dentro.length) { achados.push(...dentro); continue; }
            const corpo = doc.body.isContentEditable ? doc.body : null;
            if (corpo) {
                const tamanho = medirEl(corpo);
                if (tamanho >= 200) achados.push({ html: corpo.innerHTML, origem: 'iframe-editor:body:' + descrever(f), tamanho });
            }
        }

        // (b) CKEditor
        try {
            if (window.CKEDITOR && window.CKEDITOR.instances) {
                for (const nome of Object.keys(window.CKEDITOR.instances)) {
                    const inst = window.CKEDITOR.instances[nome];
                    if (!inst || typeof inst.getData !== 'function') continue;
                    let html = '';
                    try { html = inst.getData(); } catch (e) { continue; }
                    const tamanho = medir(html);
                    if (tamanho >= 200) achados.push({ html, origem: 'CKEditor:' + nome, tamanho });
                }
            }
        } catch (e) { }

        // (c) contenteditable genérico
        achados.push(...candidatosDe(['[contenteditable="true"]', '[contenteditable=""]', '.cke_editable'], document, 'editável'));

        return achados.sort((a, b) => b.tamanho - a.tamanho);
    }

    // 3.2 Modo visualização: containers conhecidos do PJe
    const SELETORES_DOC = [
        // minuta da tarefa (PJe 2.x): o texto fica neste span/div
        '[id*=":minuta-"] [id*="frameBody"]',
        '[id*=":minuta-"] [id*="divFrameBody"]',
        '[id*=":minuta-"]',
        // documento renderizado
        'span.text-justified',
        '[class*="text-justified"]',
        '#divDocVisualizacao',
        '#divDocumento',
        '#conteudoDocumento',
        '#divConteudoDocumento',
        '.conteudo-documento',
        '.texto-documento',
        '.documento-pje',
        '.documento',
        '.cke_editable',
        '.ql-editor',
        '[id*="isualiza"]',
        '[class*="documento"]',
    ];

    function candidatosDeContainer() {
        const achados = [];
        for (const sel of SELETORES_DOC) {
            let nos = [];
            try { nos = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
            for (const el of nos) {
                if (!foraDoOverlay(el)) continue;
                if (el.querySelectorAll('button, input, select, textarea').length > 12) continue; // é formulário
                const tamanho = medirEl(el);
                if (tamanho >= 200) achados.push({ html: el.innerHTML, origem: 'container:' + sel, tamanho });
            }
        }
        return achados.sort((a, b) => b.tamanho - a.tamanho);
    }

    // 3.2b Conteúdo dentro de ShadowRoot (fechado ou aberto) capturado no nascimento
    function candidatosDoShadow() {
        const achados = [];
        for (const raiz of raizesDeShadow()) {
            try {
                achados.push(...candidatosDe(SELETORES_EDITOR_BD, raiz, 'shadow'));

                // desce até o miolo do shadow (mesma ideia da heurística)
                let alvo = raiz;
                for (let i = 0; i < 20; i++) {
                    const n = medirEl(alvo);
                    if (n <= 0) break;
                    const filho = [...alvo.children].find((c) => temTextoUtil(c) && medirEl(c) >= n * 0.95 && foraDoOverlay(c));
                    if (!filho) break;
                    alvo = filho;
                }
                const tamanho = medirEl(alvo);
                if (tamanho >= 200 && temTextoUtil(alvo)) achados.push({ html: alvo.innerHTML, origem: 'shadow', tamanho });
            } catch (e) { }
        }
        return achados.sort((a, b) => b.tamanho - a.tamanho);
    }

    // 3.3 Reserva: maiores blocos de texto da página (desce até o miolo)
    function candidatosHeuristicos() {
        if (!document.body) return [];
        const cands = [...document.body.querySelectorAll('div, td, article, section, form, main')]
            .map((el) => ({ el, n: medirEl(el) }))
            .filter((x) => x.n >= 200 && x.el.querySelectorAll('button, input, select, textarea').length <= 12 && foraDoOverlay(x.el))
            .sort((a, b) => b.n - a.n)
            .slice(0, 6);

        const achados = [];
        for (const c of cands) {
            let alvo = c.el;
            for (let i = 0; i < 20; i++) {
                const n = medirEl(alvo);
                if (n <= 0) break;
                const filho = [...alvo.children].find((x) => temTextoUtil(x) && medirEl(x) >= n * 0.95 && foraDoOverlay(x));
                if (!filho) break;
                alvo = filho;
            }
            const tamanho = medirEl(alvo);
            if (tamanho >= 200 && temTextoUtil(alvo) && foraDoOverlay(alvo)) achados.push({ html: alvo.innerHTML, origem: 'heurística:' + descrever(alvo), tamanho });
        }
        return achados;
    }

    // Marcas típicas de peça processual. Servem para NÃO confundir a minuta com
    // os formulários que a cercam no PJe (combos "Tipo do Documento", "Modelo",
    // lista de modelos etc.) — que também têm bastante texto.
    const MARCAS_DOC = [
        /PODER JUDIC[ÍI][ÁA]RIO/i,
        /IMPETRANTE|IMPETRADO|REQUERENTE|REQUERIDO|EXEQUENTE|EXECUTADO|AGRAVANTE|AGRAVADO/i,
        /MINIST[ÉE]RIO P[ÚU]BLICO/i,
        /intime-se|notifique-se|cite-se|intimem-se|oficie-se|notifiquem-se/i,
        /\bVistos\b/i,
        /Expedientes necess[áa]rios/i,
        /no prazo de\s+\d|prazo de\s+\d+\s*\(|improrrog[áa]vel/i,
        /\bart\.\s*\d|Lei n[ºo°]\s*[\d.]/i,
        /(?:DESPACHO|DECIS[ÃA]O|SENTEN[ÇC]A)\s*$/im,
    ];

    function pareceDocumento(texto) {
        let marcas = 0;
        for (const re of MARCAS_DOC) { if (re.test(texto)) marcas++; }
        return marcas >= 2;
    }

    // Cronômetro de diagnóstico: se uma varredura demorar, avisa no console.
    // (Ajuda a achar travamentos: aparece como "[PJe modo leitura] varredura lenta".)
    function extrairMinuta() {
        const t0 = Date.now();
        const r = extrairMinutaInterno();
        const dt = Date.now() - t0;
        if (dt > 400) {
            try { console.warn('[PJe modo leitura] varredura lenta: ' + dt + ' ms — ' + location.href); } catch (e) { }
        }
        return r;
    }

    function extrairMinutaInterno() {
        // prioridade: editor (edição) > containers do PJe > heurística
        const todos = [...candidatosDoEditor(), ...candidatosDoShadow(), ...candidatosDeContainer(), ...candidatosHeuristicos()];
        if (!todos.length) return null;

        // usa o primeiro que, além de ter tamanho, "parece peça processual";
        // se nenhum parecer, devolve null (melhor não abrir do que abrir um
        // formulário com o texto errado)
        const escolhida = todos.find((t) => pareceDocumento(textoDe(t.html)));
        if (!escolhida) return null;

        const html = limparHTML(escolhida.html);
        const texto = textoDe(html).replace(/\n{3,}/g, '\n\n').trim();
        if (texto.replace(/\s+/g, '').length < 200) return null;
        return { html, texto, origem: escolhida.origem, tamanho: escolhida.tamanho, titulo: tituloDoTexto(texto) };
    }

    function tituloDoTexto(texto) {
        const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
        const tipo = linhas.find((l) => /^(DESPACHO|DECIS[ÃA]O|SENTEN[ÇC]A|ATO|OF[ÍI]CIO|ALVAR[ÁA]|PORTARIA)\b/i.test(l));
        const processo = linhas.find((l) => /N[ºo°]\s*\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/i.test(l));
        const partes = [tipo, processo].filter(Boolean);
        return partes.length ? partes.join(' — ').slice(0, 120) : (linhas[0] || document.title).slice(0, 120);
    }

    // 3.4 Limpeza do HTML (evita que o documento traga CSS/JS do PJe junto)
    const TAGS_OK = new Set(['P', 'BR', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B',
        'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD',
        'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'HR', 'PRE', 'CODE', 'CENTER']);
    const ATTR_OK = new Set(['colspan', 'rowspan', 'align', 'style']);

    // Só estas propriedades de estilo sobrevivem — formatação que importa em
    // documento jurídico. Cor de fonte/fundo ficam de fora de propósito, para
    // não brigar com os temas claro/sépia/escuro.
    const ESTILO_OK = new Set(['font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
        'text-align', 'text-indent', 'margin-left', 'padding-left', 'vertical-align', 'white-space']);
    const ESTILO_RUIM = /url\s*\(|expression\s*\(|javascript:|position\s*:|z-index|behavior\s*:|@import/i;

    function filtrarEstilo(valor) {
        return String(valor || '')
            .split(';')
            .map((p) => p.trim())
            .filter((p) => {
                const i = p.indexOf(':');
                if (i < 0) return false;
                const prop = p.slice(0, i).trim().toLowerCase();
                const val = p.slice(i + 1).trim();
                return ESTILO_OK.has(prop) && !!val && !ESTILO_RUIM.test(val);
            })
            .join('; ');
    }

    function limparHTML(html) {
        let doc;
        try { doc = new DOMParser().parseFromString('<div id="pml-raiz">' + String(html || '') + '</div>', 'text/html'); }
        catch (e) { return ''; }
        const raiz = doc.getElementById('pml-raiz');
        if (!raiz) return '';

        raiz.querySelectorAll('script, style, link, meta, iframe, object, embed, svg, img, video, audio, form, input, button, select, textarea, noscript')
            .forEach((no) => no.remove());

        for (const el of [...raiz.querySelectorAll('*')]) {
            if (!TAGS_OK.has(el.tagName)) {
                const span = doc.createElement('span');
                while (el.firstChild) span.appendChild(el.firstChild);
                el.replaceWith(span);
                continue;
            }
            for (const attr of [...el.attributes]) {
                const nome = attr.name.toLowerCase();
                if (!ATTR_OK.has(nome)) { el.removeAttribute(attr.name); continue; }
                if (nome === 'style') {
                    const limpo = filtrarEstilo(attr.value);
                    if (limpo) el.setAttribute('style', limpo);
                    else el.removeAttribute('style');
                }
            }
        }
        return raiz.innerHTML;
    }

    /* ============================================================
       4. OVERLAY DE LEITURA
       ============================================================ */
    let overlay = null;
    let doc = null;          // { html, texto, origem, titulo }
    let usuarioFechou = false; // respeita o Esc: não reabre sozinho depois disso
    let pedidoManual = false;  // um Alt+L/botão está aguardando resposta dos frames
    let timerPedidoManual = null;

    const CSS = `
#pml-overlay {
    position: fixed; inset: 0; z-index: 2147483600;
    display: flex; flex-direction: column;
    background: var(--pml-fundo); color: var(--pml-texto);
    font-family: Georgia, 'Times New Roman', serif;
}
#pml-overlay[data-tema="claro"]  { --pml-fundo:#eef0f3; --pml-painel:#ffffff; --pml-texto:#1b1f24; --pml-borda:#d9dde3; --pml-suave:#5d6672; --pml-botao:#ffffff; }
#pml-overlay[data-tema="sepia"]  { --pml-fundo:#e6dcc6; --pml-painel:#f8f3e6; --pml-texto:#3a3226; --pml-borda:#d6c9ad; --pml-suave:#6d5f49; --pml-botao:#fdf8ec; }
#pml-overlay[data-tema="escuro"] { --pml-fundo:#12141a; --pml-painel:#1c1f26; --pml-texto:#e9e7e4; --pml-borda:#2d323b; --pml-suave:#a6acb6; --pml-botao:#232830; }

#pml-barra {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 14px; background: var(--pml-painel);
    border-bottom: 1px solid var(--pml-borda);
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
}
#pml-barra .pml-titulo {
    font-weight: 600; margin-right: auto; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; max-width: 45vw;
}
#pml-barra .pml-info { color: var(--pml-suave); white-space: nowrap; }
#pml-barra button {
    font: inherit; cursor: pointer; padding: 5px 10px; border-radius: 6px;
    border: 1px solid var(--pml-borda); background: var(--pml-botao); color: var(--pml-texto);
    line-height: 1.1;
}
#pml-barra button:hover { filter: brightness(0.96); }
#pml-barra button[data-a="fechar"] { font-weight: 600; }
#pml-rolagem { flex: 1; overflow: auto; padding: 34px 16px 80px; }
#pml-conteudo {
    max-width: var(--pml-largura); margin: 0 auto;
    background: var(--pml-painel); color: var(--pml-texto);
    border: 1px solid var(--pml-borda); border-radius: 8px;
    padding: 44px 52px;
    font-size: var(--pml-fonte); line-height: var(--pml-entrelinha);
    box-shadow: 0 6px 24px rgba(0,0,0,.10);
}
#pml-conteudo p { margin: 0 0 .85em; }
#pml-conteudo h1, #pml-conteudo h2, #pml-conteudo h3,
#pml-conteudo h4, #pml-conteudo h5, #pml-conteudo h6 { line-height: 1.3; margin: 1.2em 0 .6em; }
#pml-conteudo table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: .95em; }
#pml-conteudo td, #pml-conteudo th { border: 1px solid var(--pml-borda); padding: 6px 8px; }
#pml-conteudo blockquote { margin: .8em 0 .8em 1.5em; padding-left: 1em; border-left: 3px solid var(--pml-borda); color: var(--pml-suave); }
#pml-conteudo img { max-width: 100%; }
#pml-conteudo:focus { outline: none; }

#pml-botao-flutuante {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483500;
    display: flex; align-items: center; gap: 6px;
    padding: 7px 11px; border-radius: 999px; cursor: pointer;
    border: 1px solid rgba(31,111,235,.45); background: #1f6feb; color: #fff;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 12px; font-weight: 500;
    box-shadow: 0 2px 8px rgba(0,0,0,.14);
    opacity: .62;
    transition: opacity .18s ease, box-shadow .18s ease;
}
#pml-botao-flutuante:hover {
    opacity: 1; box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
#pml-botao-flutuante:focus-visible {
    opacity: 1; box-shadow: 0 4px 14px rgba(0,0,0,.25);
    outline: 2px solid rgba(31,111,235,.55); outline-offset: 2px;
}
`;

    function injetarCSS() {
        if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; }
        const s = document.createElement('style');
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    function aplicarPreferencias() {
        if (!overlay) return;
        overlay.dataset.tema = cfg.tema;
        overlay.style.setProperty('--pml-fonte', cfg.fonte + 'px');
        overlay.style.setProperty('--pml-entrelinha', cfg.entrelinha);
        overlay.style.setProperty('--pml-largura', cfg.largura ? cfg.largura + 'px' : '100%');
        const info = overlay.querySelector('.pml-info');
        if (info) info.textContent = `${cfg.fonte}px · ${cfg.largura ? cfg.largura + 'px' : 'largura total'} · ${TEMAS.indexOf(cfg.tema) + 1}/3`;
    }

    function montarOverlay() {
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'pml-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const barra = document.createElement('div');
        barra.id = 'pml-barra';

        const titulo = document.createElement('span');
        titulo.className = 'pml-titulo';
        titulo.textContent = 'Modo leitura';

        const info = document.createElement('span');
        info.className = 'pml-info';

        const botoes = [
            ['menos', 'A−', 'Diminuir fonte (−)'],
            ['mais', 'A+', 'Aumentar fonte (+)'],
            ['largura', 'Largura', 'Alternar largura da coluna (W)'],
            ['tema', 'Tema', 'Alternar tema (T)'],
            ['copiar', 'Copiar', 'Copiar o texto'],
            ['imprimir', 'Imprimir', 'Imprimir / salvar em PDF'],
            ['fechar', 'Fechar (Esc)', 'Fechar o modo leitura'],
        ].map(([acao, rotulo, dica]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.a = acao;
            b.textContent = rotulo;
            b.title = dica;
            return b;
        });

        barra.append(titulo, info, ...botoes);

        const rolagem = document.createElement('div');
        rolagem.id = 'pml-rolagem';
        const conteudo = document.createElement('article');
        conteudo.id = 'pml-conteudo';
        conteudo.tabIndex = 0;
        rolagem.appendChild(conteudo);

        overlay.append(barra, rolagem);

        barra.addEventListener('click', (ev) => {
            const b = ev.target.closest('button[data-a]');
            if (!b) return;
            acao(b.dataset.a);
        });
        overlay.addEventListener('keydown', (ev) => atalho(ev));
        document.body.appendChild(overlay);

        aplicarPreferencias();
        return overlay;
    }

    function acao(a) {
        switch (a) {
            case 'menos': cfg.fonte = Math.max(12, cfg.fonte - 2); salvarCfg(); aplicarPreferencias(); break;
            case 'mais': cfg.fonte = Math.min(48, cfg.fonte + 2); salvarCfg(); aplicarPreferencias(); break;
            case 'largura': {
                const i = LARGURAS.indexOf(cfg.largura);
                cfg.largura = LARGURAS[(i + 1) % LARGURAS.length];
                salvarCfg(); aplicarPreferencias(); break;
            }
            case 'tema': {
                cfg.tema = TEMAS[(TEMAS.indexOf(cfg.tema) + 1) % TEMAS.length];
                salvarCfg(); aplicarPreferencias(); break;
            }
            case 'copiar': copiarTexto(); break;
            case 'imprimir': imprimir(); break;
            case 'fechar': fechar(); break;
        }
    }

    function atalho(ev) {
        if (!overlay) return;
        const k = ev.key;
        if (k === 'Escape') { ev.preventDefault(); fechar(); }
        else if (k === '+' || k === '=') { ev.preventDefault(); acao('mais'); }
        else if (k === '-' || k === '_') { ev.preventDefault(); acao('menos'); }
        else if (k === 't' || k === 'T') { ev.preventDefault(); acao('tema'); }
        else if (k === 'w' || k === 'W') { ev.preventDefault(); acao('largura'); }
    }

    function copiarTexto() {
        const t = doc ? doc.texto : '';
        const feito = () => avisar('Texto copiado.');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(feito, () => copiarAntigo(t, feito));
        } else {
            copiarAntigo(t, feito);
        }
    }
    function copiarAntigo(t, feito) {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); feito(); } catch (e) { }
        ta.remove();
    }

    function imprimir() {
        if (!doc) return;
        const w = window.open('', '_blank');
        if (!w) return;
        w.document.write(
            '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
            '<title>' + (doc.titulo || 'Minuta').replace(/[<>&]/g, '') + '</title>' +
            '<style>body{font-family:Georgia,"Times New Roman",serif;font-size:12pt;line-height:1.5;margin:2.5cm 2cm;color:#000}' +
            'p{margin:0 0 .8em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px}</style>' +
            '</head><body>' + doc.html + '</body></html>'
        );
        w.document.close();
        w.focus();
        setTimeout(() => { try { w.print(); } catch (e) { } }, 300);
    }

    function avisar(msg) {
        if (!overlay) return;
        const info = overlay.querySelector('.pml-info');
        if (!info) return;
        const anterior = info.textContent;
        info.textContent = msg;
        setTimeout(() => { if (overlay) aplicarPreferencias(); else info.textContent = anterior; }, 1500);
    }

    // Desenha o `doc` atual no overlay. Separado de abrir() porque também é
    // chamado quando chega texto NOVO dos frames (ver listener de message) —
    // é isso que faz o modo leitura mostrar a minuta EDITADA, e não a que
    // estava na tela quando ele abriu pela primeira vez.
    // Se o overlay já estava visível, preserva a posição de rolagem; se estava
    // fechado, começa do topo.
    function renderizar() {
        if (!overlay || !doc) return;
        const rolagem = overlay.querySelector('#pml-rolagem');
        const estavaVisivel = overlay.style.display !== 'none';
        const topo = estavaVisivel && rolagem ? rolagem.scrollTop : 0;
        overlay.querySelector('.pml-titulo').textContent = doc.titulo || 'Modo leitura';
        overlay.querySelector('#pml-conteudo').innerHTML = doc.html;
        if (rolagem) rolagem.scrollTop = topo;
    }

    function abrir(novoDoc, manual) {
        if (manual) usuarioFechou = false;
        else if (usuarioFechou) return false; // o usuário fechou: não insistir
        if (novoDoc) doc = novoDoc;
        if (!doc) return false;

        montarOverlay();
        renderizar();
        overlay.style.display = 'flex';
        aplicarPreferencias();
        overlay.querySelector('#pml-conteudo').focus();
        document.documentElement.style.overflow = 'hidden';
        return true;
    }

    function fechar() {
        if (!overlay) return;
        usuarioFechou = true;
        pedidoManual = false; // se um pedido estava em curso, não reabra depois
        overlay.style.display = 'none';
        document.documentElement.style.overflow = '';
    }

    function botaoFlutuante() {
        if (document.getElementById('pml-botao-flutuante')) return;
        const b = document.createElement('button');
        b.id = 'pml-botao-flutuante';
        b.type = 'button';
        b.title = 'Abrir a minuta em modo leitura (Alt+L)';
        b.textContent = '📖 Modo leitura';
        b.addEventListener('click', () => pedirMinuta(true));
        (document.body || document.documentElement).appendChild(b);
    }

    /* ============================================================
       5. PONTE ENTRE FRAMES (a minuta mora dentro de iframes)
       ============================================================ */
    const MSG = 'pjeMinutaModoLeitura';

    function enviarParaTopo(minuta) {
        if (ESTOU_NO_TOPO) return false;
        try {
            window.top.postMessage({ pml: MSG, tipo: 'documento', doc: minuta }, '*');
            return true;
        } catch (e) { return false; }
    }

    function responderAoTopo(minuta) {
        try { window.top.postMessage({ pml: MSG, tipo: 'documento', doc: minuta }, '*'); } catch (e) { }
    }

    // Qualidade da ORIGEM do texto: quanto menor, melhor. Serve para o topo não
    // trocar a minuta editada (editor/ProseMirror/shadow) pelo "backup" que o
    // PJe guarda em [id*=":minuta-"] (container), que fica com o texto de quando
    // a tarefa abriu.
    function pesoOrigem(origem) {
        const o = String(origem || '');
        if (o.indexOf('editor') === 0 || o.indexOf('iframe-editor') === 0 ||
            o.indexOf('CKEditor') === 0 || o.indexOf('editável') === 0) return 0;
        if (o.indexOf('shadow') === 0) return 1;
        if (o.indexOf('container') === 0) return 2;
        return 3;
    }

    // Pede a extração a TODOS os frames descendentes — não só aos filhos
    // diretos. Na cadeia do PJe 2.x a minuta vive num neto:
    //   top (dev.seam) -> iframe #ngFrame (frontend-prd, SEM o script)
    //                  -> iframe movimentar.seam (é aqui que está a minuta)
    // e o frame intermediário é de outra origem, então não repassa o pedido.
    // As propriedades `frames`/`length` de um WindowProxy são acessíveis mesmo
    // entre origens diferentes, o que permite descer a árvore daqui.
    function pedirAosFrames() {
        let enviados = 0;
        const visitar = (win, nivel) => {
            if (!win || nivel > 6) return;
            let total = 0;
            try { total = win.frames.length || 0; } catch (e) { return; }
            for (let i = 0; i < total; i++) {
                let f = null;
                try { f = win.frames[i]; } catch (e) { continue; }
                try { f.postMessage({ pml: MSG, tipo: 'pedir' }, '*'); enviados++; } catch (e) { }
                visitar(f, nivel + 1);
            }
        };
        visitar(window, 0);
        return enviados;
    }

    function pedirMinuta(manual) {
        if (ESTOU_NO_TOPO) {
            if (manual) {
                // Marca que ESTE pedido é do usuário (Alt+L/botão): quando a
                // resposta chegar, o overlay abre/atualiza mesmo que a abertura
                // automática já tenha sido gasta neste carregamento.
                pedidoManual = true;
                clearTimeout(timerPedidoManual);
                timerPedidoManual = setTimeout(() => { pedidoManual = false; }, 5000);
            }
            // 1) o editor pode estar neste próprio documento (ou dentro de um
            //    ShadowRoot capturado aqui) — tenta antes de perguntar aos filhos.
            //    A checagem de "pista" evita varrer o documento inteiro a cada
            //    ciclo quando a página não tem editor nenhum.
            const proprio = temPistaDeEditor() ? extrairMinuta() : null;
            if (proprio) {
                const mudou = !doc || doc.texto !== proprio.texto;
                doc = proprio;
                pedidoManual = false; // resolvido aqui: nada a esperar dos frames
                clearTimeout(timerPedidoManual);
                if (mudou || (overlay && overlay.style.display === 'none')) abrir(null, manual);
                return;
            }
            // 2) pergunta aos frames (inclusive netos — ver pedirAosFrames).
            //    Mostra na hora o que já está em cache; se a resposta trouxer
            //    texto diferente (a minuta foi editada), o overlay se atualiza
            //    sozinho quando a mensagem chegar (ver listener de message).
            pedirAosFrames();
            if (doc && (manual || (overlay && overlay.style.display === 'none'))) abrir(null, manual);
        } else {
            const m = extrairMinuta();
            if (m) responderAoTopo(m);
            else { try { window.top.postMessage({ pml: MSG, tipo: 'nao-achei' }, '*'); } catch (e) { } }
        }
    }

    window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || typeof d !== 'object' || d.pml !== MSG) return;

        if (ESTOU_NO_TOPO) {
            if (d.tipo === 'documento' && d.doc && d.doc.texto) {
                const novo = d.doc;
                const mudou = !doc || doc.texto !== novo.texto;
                const aguardando = pedidoManual;
                const pior = !!doc && pesoOrigem(novo.origem) > pesoOrigem(doc.origem);
                pedidoManual = false;

                if (!mudou) return;

                // Texto de qualidade inferior (ex.: o "backup" antigo do PJe)
                // não sobrescreve o que já está na tela.
                if (pior && (aguardando || (overlay && overlay.style.display !== 'none'))) return;

                doc = novo;

                // Overlay aberto (ou pedido manual): REDESENHA com o texto novo.
                // É isto que faz o modo leitura mostrar a minuta editada em vez
                // da que estava na tela na primeira abertura.
                if (aguardando || (overlay && overlay.style.display !== 'none')) { abrir(null, true); return; }

                if (cfg.autoAbrir && !usuarioFechou && !jaAbriuNesteCarregamento()) { abrir(); marcarAbriu(); }
                else if (!cfg.autoAbrir) { avisar('Minuta detectada — clique em "Modo leitura".'); }
            }
            return;
        }

        if (d.tipo === 'pedir') {
            const m = extrairMinuta();
            if (m) { responderAoTopo(m); return; }
            // Repassa o pedido para os iframes filhos: no PJe 2.x o editor fica
            // em iframe#editorEstruturadoFrame, e pode estar ainda mais fundo.
            [...document.querySelectorAll('iframe')].forEach((f) => {
                try { f.contentWindow.postMessage({ pml: MSG, tipo: 'pedir' }, '*'); } catch (e) { }
            });
        }
    });

    function jaAbriuNesteCarregamento() {
        try { return sessionStorage.getItem(CHAVE_ABRIU) === '1'; } catch (e) { return false; }
    }
    function marcarAbriu() {
        try { sessionStorage.setItem(CHAVE_ABRIU, '1'); } catch (e) { }
    }

    /* ============================================================
       6. INICIALIZAÇÃO
       ============================================================ */
    function atalhoGlobal(ev) {
        if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && (ev.key === 'l' || ev.key === 'L')) {
            ev.preventDefault();
            // Sempre PEDE a minuta de novo (re-extrai neste documento e pergunta
            // aos frames). Antes, com um `doc` em cache, o Alt+L só redesenhava
            // o cache — e o modo leitura reaparecia com o texto de ANTES das
            // edições feitas no editor.
            pedirMinuta(true);
        }
    }

    function iniciar() {
        try { iniciarInterno(); } catch (e) { }
    }

    function iniciarInterno() {
        injetarCSS();
        document.addEventListener('keydown', atalhoGlobal, true);

        // O editor pode nascer depois do nosso script: reaplica o patch de
        // attachShadow no realm do iframe dele durante os primeiros segundos.
        patcharFramesDoEditor();
        let nPatch = 0;
        const tPatch = setInterval(() => {
            patcharFramesDoEditor();
            if (++nPatch >= 20) clearInterval(tPatch);
        }, 500);

        if (ESTOU_NO_TOPO) {
            botaoFlutuante();
            // Só tenta no próprio documento se houver indício de editor — assim
            // o script fica inerte em páginas sem minuta (ex.: o Painel).
            if (temPistaDeEditor()) {
                const m = extrairMinuta();
                if (m) {
                    doc = m;
                    if (cfg.autoAbrir && !jaAbriuNesteCarregamento()) { abrir(); marcarAbriu(); }
                }
            }
            // Sem polling periódico: quem tem a minuta avisa o topo por
            // postMessage (auto-abertura) e o botão/Alt+L pedem sob demanda.
            return;
        }

        // frame interno: avisa o topo quando achar a minuta
        const tentar = () => {
            if (!temPistaDeEditor()) return false; // barato: não varre página sem editor
            const m = extrairMinuta();
            if (m) { enviarParaTopo(m); return true; }
            return false;
        };
        if (tentar()) return;

        let n = 0;
        const timer = setInterval(() => {
            n++;
            if (tentar() || n >= 10) clearInterval(timer);
        }, 1000);

        let agendado = null;
        const obs = new MutationObserver(() => {
            if (agendado) return; // debounce: 1 varredura a cada 800 ms, no máximo
            agendado = setTimeout(() => {
                agendado = null;
                if (tentar()) obs.disconnect();
            }, 800);
        });
        try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { }
    }

    // Hook de diagnóstico: no Console,
    //   __pmlExtrair()     -> devolve a minuta que seria escolhida (ou null)
    //   __pmlDiagnostico() -> lista os candidatos e quantos shadow roots foram
    //                         capturados (cola isto se algo não aparecer)
    try {
        window.__pmlExtrair = extrairMinuta;
        window.__pmlDiagnostico = () => ({
            url: location.href,
            sombrasCapturadas: sombrasCapturadas.length,
            iframes: todosOsIframes().map((f) => {
                let temDoc = false, temEditor = false;
                try {
                    const d = f.contentDocument;
                    temDoc = !!d;
                    temEditor = !!(d && d.querySelector(SELETOR_PISTA));
                } catch (e) { }
                return { desc: descrever(f), src: f.getAttribute('src'), temDoc, temEditor };
            }),
            candidatos: [...candidatosDoEditor(), ...candidatosDoShadow(), ...candidatosDeContainer(), ...candidatosHeuristicos()]
                .slice(0, 12)
                .map((t) => ({
                    origem: t.origem,
                    tamanho: t.tamanho,
                    pareceDocumento: pareceDocumento(textoDe(t.html)),
                    inicio: textoDe(t.html).replace(/\s+/g, ' ').slice(0, 90),
                })),
            escolhida: (() => {
                const m = extrairMinuta();
                return m ? { origem: m.origem, titulo: m.titulo, chars: m.texto.length } : null;
            })(),
        });
    } catch (e) { }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar, { once: true });
    } else {
        iniciar();
    }

    // menu do Tampermonkey (na aba de topo)
    try {
        if (typeof GM_registerMenuCommand === 'function' && ESTOU_NO_TOPO) {
            GM_registerMenuCommand('Abrir/fechar modo leitura', () => {
                if (overlay && overlay.style.display !== 'none') fechar();
                else pedirMinuta(true); // sempre re-extrai (o cache pode estar velho)
            });
            GM_registerMenuCommand('Ligar/desligar abertura automática', () => {
                cfg.autoAbrir = !cfg.autoAbrir;
                salvarCfg();
                alert('Abertura automática: ' + (cfg.autoAbrir ? 'LIGADA' : 'DESLIGADA'));
            });
        }
    } catch (e) { }
})();
