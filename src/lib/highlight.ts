import hljs from 'highlight.js/lib/common';
import type { Hunk } from '../../shared/types';

/** A run of text with the highlight.js scope classes that apply to it. */
export interface Segment {
  text: string;
  cls?: string;
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  m: 'objectivec',
  mm: 'objectivec',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  sql: 'sql',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  vb: 'vbnet',
  wasm: 'wasm',
};

const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
};

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = BY_NAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const lang = BY_EXTENSION[base.slice(dot + 1)];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

const MAX_CHARS = 300_000;
const MAX_LINE = 2_000;

/** Highlight a block of consecutive lines, returning segments per line. */
export function highlightLines(lines: string[], lang: string): Segment[][] | null {
  const code = lines.join('\n');
  if (code.length > MAX_CHARS || lines.some((l) => l.length > MAX_LINE)) return null;
  let html: string;
  try {
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  // highlight.js escapes the source; parse its markup inertly and walk the text nodes.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out: Segment[][] = [[]];
  const walk = (node: Node, classes: string[]) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? '').split('\n');
        parts.forEach((part, i) => {
          if (i > 0) out.push([]);
          if (part) out[out.length - 1].push({ text: part, cls: classes.length ? classes.join(' ') : undefined });
        });
      } else if (child instanceof Element) {
        walk(child, child.className ? [...classes, child.className] : classes);
      }
    });
  };
  walk(tpl.content, []);
  return out;
}

/**
 * Highlight a diff hunk. The old side (context + deletions) and new side (context + additions)
 * are highlighted as separate continuous blocks so multi-line constructs stay correct.
 */
export function highlightHunk(hunk: Hunk, lang: string): (Segment[] | undefined)[] {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  hunk.lines.forEach((l, i) => {
    if (l.type !== 'add') {
      oldIdx[i] = oldLines.length;
      oldLines.push(l.content);
    }
    if (l.type !== 'del') {
      newIdx[i] = newLines.length;
      newLines.push(l.content);
    }
  });
  const oldHl = oldLines.length ? highlightLines(oldLines, lang) : [];
  const newHl = newLines.length ? highlightLines(newLines, lang) : [];
  return hunk.lines.map((l, i) => (l.type === 'del' ? oldHl?.[oldIdx[i]] : newHl?.[newIdx[i]]));
}
