/* =====================================================================
   PJe - DIAGNÓSTICO 5: o texto da minuta está no DOM? (modo EDIÇÃO)
   ---------------------------------------------------------------------
   Procura uma frase marcante da minuta (por padrão "Defiro os benefícios")
   em TODO o documento — inclusive dentro de shadow roots ABERTOS — e diz
   exatamente onde ela mora (ou avisa que não está no DOM).

   Rode no Console com o contexto do frame movimentar.seam (modo edição).
   Se a frase da sua minuta for outra, troque FRASES abaixo.
   Não altera nada: só lê.
   ===================================================================== */
(() => {
    const FRASES = ['Defiro os benefícios', 'PODER JUDICIÁRIO'];

    const T = (e) => ((e && (e.innerText || e.textContent)) || '');
    const corta = (s, n) => (s || '').replace(/\s+/g, ' ').slice(0, n);
    const cls = (e) => (typeof e.className === 'string' ? e.className : '').slice(0, 60);
    const desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls(e) ? '.' + cls(e).split(' ')[0] : '');
    const cadeia = (e) => {
        const p = [];
        let x = e;
        while (x && x.nodeType === 1 && p.length < 6) { p.push(desc(x)); x = x.parentElement; }
        return p.join(' < ');
    };

    const out = { url: location.href, frases: FRASES };

    // 1) o texto está no DOM desta frame?
    out.noDom = {};
    for (const frase of FRASES) {
        let innerText = false, textContent = false;
        try { innerText = ((document.body && document.body.innerText) || '').includes(frase); } catch (e) { }
        try { textContent = ((document.body && document.body.textContent) || '').includes(frase); } catch (e) { }
        out.noDom[frase] = { innerText, textContent };
    }

    // 2) containers MAIS INTERNOS que contêm a frase (shadow roots abertos incluídos)
    const encontrados = [];
    const varrer = (raiz) => {
        if (!raiz) return;
        let todos = [];
        try { todos = [...raiz.querySelectorAll('*')]; } catch (e) { return; }
        for (const el of todos) {
            if (el.shadowRoot) varrer(el.shadowRoot);
            let txt = '';
            try { txt = T(el); } catch (e) { continue; }
            const frase = FRASES.find((f) => txt.includes(f));
            if (!frase) continue;
            const algumFilhoTem = [...el.children].some((c) => { try { return T(c).includes(frase); } catch (e) { return false; } });
            if (!algumFilhoTem) {
                encontrados.push({ frase, el: desc(el), cadeia: cadeia(el), chars: T(el).replace(/\s+/g, '').length, head: corta(txt, 200) });
            }
        }
    };
    varrer(document);
    out.encontrados = encontrados.slice(0, 10);

    // 3) shadow roots ABERTOS (se o editor usar shadow fechado, isto vem vazio)
    const sombras = [];
    const acharSombras = (raiz, nivel) => {
        if (!raiz || nivel > 4) return;
        let todos = [];
        try { todos = [...raiz.querySelectorAll('*')]; } catch (e) { return; }
        for (const el of todos) {
            if (!el.shadowRoot) continue;
            const txt = T(el.shadowRoot).replace(/\s+/g, '');
            sombras.push({
                el: desc(el),
                chars: txt.length,
                temFrase: FRASES.some((f) => T(el.shadowRoot).includes(f)),
            });
            acharSombras(el.shadowRoot, nivel + 1);
        }
    };
    acharSombras(document, 0);
    out.shadowAbertos = sombras.slice(0, 8);

    // 4) o iframe do editor, por dentro
    let editor = null;
    const f = document.getElementById('editorEstruturadoFrame');
    if (f) {
        try {
            const d = f.contentDocument;
            editor = {
                docHTMLlen: d.documentElement ? d.documentElement.outerHTML.length : -1,
                bodyChildren: d.body ? d.body.children.length : -1,
                elementos: [...d.querySelectorAll('*')].slice(0, 25).map(desc),
                bodyHTML: d.body ? corta(d.body.innerHTML, 400) : null,
                bodyInnerTextTemFrase: d.body ? FRASES.some((fr) => (d.body.innerText || '').includes(fr)) : null,
                bodyTextContentTemFrase: d.body ? FRASES.some((fr) => (d.body.textContent || '').includes(fr)) : null,
            };
        } catch (e) { editor = 'sem acesso: ' + e.message; }
    }
    out.editorFrame = editor;

    // 5) pistas extras
    out.canvas = document.querySelectorAll('canvas').length;
    out.totalElementos = document.querySelectorAll('*').length;
    out.apoiaPresente = !!document.getElementById('apoia-mcp-assistant-root');

    console.log(JSON.stringify(out, null, 1));
    if (typeof copy === 'function') { copy(JSON.stringify(out)); console.log('%c(copiado)', 'color:#0a0'); }
    return out;
})();
