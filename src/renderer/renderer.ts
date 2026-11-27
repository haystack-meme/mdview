import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Crepe } from '@milkdown/crepe';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import 'highlight.js/styles/github.css';
import './hljs-dark.css';
import './style.css';
import type { DocInfo, MenuCommand } from '../shared';

type Mode = 'view' | 'rich' | 'plain';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewEl = $<HTMLElement>('view');
const richEl = $<HTMLDivElement>('rich');
const plainEl = $<HTMLTextAreaElement>('plain');
const scroller = $<HTMLElement>('scroller');
const btnEdit = $<HTMLButtonElement>('btn-edit');
const btnRich = $<HTMLButtonElement>('btn-rich');
const btnPlain = $<HTMLButtonElement>('btn-plain');
const btnSave = $<HTMLButtonElement>('btn-save');
const editControls = $<HTMLDivElement>('edit-controls');
const filenameEl = $<HTMLSpanElement>('filename');
const dirtyEl = $<HTMLSpanElement>('dirty');

const api = window.mdview;

let doc: DocInfo = { path: null, content: "", baseUrl: null };
let text = ''; // current working markdown
let dirty = false;
let mode: Mode = 'view';
let editorKind: 'rich' | 'plain' = 'rich'; // last editor used in this window
let crepe: Crepe | null = null;
let crepeBaseline = ''; // crepe's serialization of `text` when it was loaded

// ---------- view rendering ----------

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function makeMarked() {
  const slugs = new Map<string, number>();
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let slug = slugify(inner) || 'section';
        const n = slugs.get(slug) ?? 0;
        slugs.set(slug, n + 1);
        if (n) slug += `-${n}`;
        return `<h${depth} id="${slug}">${inner}</h${depth}>\n`;
      },
      code({ text: code, lang }) {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        let html: string;
        if (language && hljs.getLanguage(language)) {
          html = hljs.highlight(code, { language }).value;
        } else {
          html = escapeHtml(code);
        }
        const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"';
        return `<pre><code${cls}>${html}</code></pre>\n`;
      },
    },
  });
}

function renderView() {
  const html = makeMarked().parse(text, { async: false }) as string;
  viewEl.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['id'] });
  // Task-list checkboxes are display-only in view mode.
  viewEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.disabled = true));
}

// Route all link clicks through the main process (new window / browser / file manager).
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  // In the rich editor, plain clicks place the cursor; Ctrl+click follows the link.
  if (mode === 'rich' && richEl.contains(a) && !e.ctrlKey) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  if (href.startsWith('#')) {
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    target?.scrollIntoView();
    return;
  }
  api.openLink(href);
});

// ---------- rich editor ----------

async function destroyCrepe() {
  if (crepe) {
    const c = crepe;
    crepe = null;
    await c.destroy();
    richEl.innerHTML = '';
  }
}

async function createCrepe() {
  await destroyCrepe();
  const c = new Crepe({
    root: richEl,
    defaultValue: text,
    features: { [Crepe.Feature.Latex]: false, [Crepe.Feature.AI]: false },
  });
  // Keep the document's own list bullet style (remark defaults to '*').
  const bullet = (/^\s*([-*+])\s/m.exec(text)?.[1] ?? '-') as '-' | '*' | '+';
  c.editor.config((ctx) => ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet })));
  await c.create();
  crepeBaseline = c.getMarkdown();
  c.on((l) =>
    l.markdownUpdated((_ctx, md) => {
      if (crepe !== c) return;
      if (md === crepeBaseline) return;
      text = md;
      crepeBaseline = md;
      setDirty(true);
    }),
  );
  crepe = c;
}

// ---------- modes ----------

function syncFromEditor() {
  if (mode === 'plain') text = plainEl.value;
  // rich mode keeps `text` up to date via its listener
}

async function setMode(next: Mode) {
  if (next === mode) return;
  syncFromEditor();
  const prev = mode;
  mode = next;

  viewEl.hidden = next !== 'view';
  richEl.hidden = next !== 'rich';
  plainEl.hidden = next !== 'plain';
  editControls.hidden = next === 'view';
  btnEdit.textContent = next === 'view' ? 'Edit' : 'Done';
  btnEdit.classList.toggle('active', next !== 'view');
  btnRich.classList.toggle('active', next === 'rich');
  btnPlain.classList.toggle('active', next === 'plain');

  if (prev === 'rich') await destroyCrepe();

  if (next === 'view') {
    renderView();
  } else {
    editorKind = next;
    if (next === 'rich') {
      await createCrepe();
      (richEl.querySelector('.ProseMirror') as HTMLElement | null)?.focus();
    } else {
      plainEl.value = text;
      plainEl.focus();
    }
  }
  api.setEditing(next !== 'view');
}

function toggleEdit() {
  return setMode(mode === 'view' ? editorKind : 'view');
}

// Reload the current mode's display from `text` (after external change).
async function refresh() {
  if (mode === 'view') renderView();
  else if (mode === 'plain') plainEl.value = text;
  else await createCrepe();
}

// ---------- dirty / save ----------

function setDirty(d: boolean) {
  if (d === dirty) return;
  dirty = d;
  dirtyEl.hidden = !d;
  api.setDirty(d);
}

function applyDocInfo(info: DocInfo) {
  doc = info;
  const name = info.path ? info.path.split('/').pop()! : 'Untitled';
  filenameEl.textContent = name;
  filenameEl.title = info.path ?? '';
  let base = document.querySelector('base');
  if (info.baseUrl) {
    if (!base) {
      base = document.createElement('base');
      document.head.prepend(base);
    }
    base.href = info.baseUrl;
  } else base?.remove();
}

async function save(as = false) {
  syncFromEditor();
  const res = as ? await api.saveAs(text) : await api.save(text);
  if (!res) return false;
  applyDocInfo(res);
  setDirty(false);
  return true;
}

plainEl.addEventListener('input', () => {
  text = plainEl.value;
  setDirty(true);
});

// Tab inserts two spaces in the plain editor instead of moving focus.
plainEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    plainEl.setRangeText('  ', plainEl.selectionStart, plainEl.selectionEnd, 'end');
    plainEl.dispatchEvent(new Event('input'));
  }
});

btnEdit.addEventListener('click', () => toggleEdit());
btnRich.addEventListener('click', () => setMode('rich'));
btnPlain.addEventListener('click', () => setMode('plain'));
btnSave.addEventListener('click', () => save());

api.onMenu(async (cmd: MenuCommand) => {
  switch (cmd) {
    case 'save':
      return save();
    case 'save-as':
      return save(true);
    case 'save-and-close':
      if (await save()) api.closeAfterSave();
      return;
    case 'toggle-edit':
      return toggleEdit();
    case 'rich':
    case 'plain':
      return setMode(cmd);
  }
});

api.onExternalChange(async (content) => {
  syncFromEditor();
  if (dirty && !(await api.confirmReload())) return;
  const top = scroller.scrollTop;
  text = content;
  setDirty(false);
  await refresh();
  scroller.scrollTop = top;
});

// ---------- start ----------

(async () => {
  applyDocInfo(await api.init());
  text = doc.content;
  renderView();
  // A new, untitled document has nothing to view, so start editing.
  if (!doc.path) await setMode('rich');
})();
