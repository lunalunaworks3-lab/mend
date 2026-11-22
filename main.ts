// mend: one patch tool for every AI edit format, built to SPEC.md (version 1).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): the hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n (SPEC.md section 3). */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** A file as lines with its own line break and whether it ends with one (SPEC.md section 3). */
interface Model {
  lines: string[];
  br: string;
  fin: boolean;
}

function toModel(text: string): Model {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function toText(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Moves = Array<[string, string]>;
type Edit = (tree: Tree, moves: Moves) => void;

/** Section 5 matching: tiers 0 (exact), 1 (trailing blanks off), 2 (both ends off). */
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

function eqAt(tier: number, a: string, b: string): boolean {
  return tier === 0 ? a === b : tier === 1 ? rstrip(a) === rstrip(b) : strip(a) === strip(b);
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eqAt(tier, lines[i + j]!, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function tiersOf(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at or after `from`, with its occurrences there. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const t of tiersOf(strict)) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The lines that replace the matched ones: a context line is written as the file's own matched line; at tier 2
 * every other new line is re-indented from O's first line's indent to the file's first matched line's.
 * ctx[j] is the index into O of the context line N[j] came from, or -1 for a purely new line.
 */
function buildNew(n: string[], ctx: number[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const f = lead(fileLines[pos] ?? '');
  const p = lead(o[0] ?? '');
  return n.map((line, j) => {
    const ci = ctx[j]!;
    if (ci >= 0) return fileLines[pos + ci]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** Split a patch body's entries into O (context and old), N (context and new) and the context map of N. */
function splitBody(body: Array<{ k: string; t: string }>): { o: string[]; n: string[]; ctx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: number[] = [];
  for (const e of body) {
    if (e.k === ' ') {
      ctx.push(o.length);
      o.push(e.t);
      n.push(e.t);
    } else if (e.k === '-') {
      o.push(e.t);
    } else if (e.k === '+') {
      ctx.push(-1);
      n.push(e.t);
    }
  }
  return { o, n, ctx };
}

/** Whether a `\` line follows the body's last context or `+` line (the no-final-break mark). */
function backslashAfterLastWritten(body: Array<{ k: string; t: string }>): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const k = body[i]!.k;
    if (k === ' ' || k === '+') return body[i + 1]?.k === '\\';
  }
  return false;
}

/** Section 6: unified diffs. */

interface UBody {
  k: string;
  t: string;
  empty: boolean;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

const DEVNULL = '\u0000/dev/null';

/** The path a --- or +++ line names: after the four characters, up to the first tab, spaces removed. */
function headerPath(raw: string): string {
  const p = raw.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return DEVNULL;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const start = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = start();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) start();
      cur!.pairOld = headerPath(line);
      cur!.pairNew = headerPath(lines[i + 1]!);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = l[0];
        if (l === '') hunk.body.push({ k: ' ', t: '', empty: true });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') hunk.body.push({ k: c, t: l.slice(1), empty: false });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return sections;
}

function applyHunks(model: Model, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, ctx } = splitBody(hunk.body);
    if (o.length === 0) {
      const p = Math.min(hunk.a + d, model.lines.length);
      if (n.length > 0) {
        model.lines.splice(p, 0, ...n);
        if (p === model.lines.length - n.length) model.fin = !backslashAfterLastWritten(hunk.body);
      }
    } else {
      const found = findTier(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.occ[0]!;
      for (const cand of found.occ) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const written = buildNew(n, ctx, model.lines, pos, o, found.tier);
      const runsToEnd = pos + o.length === model.lines.length;
      model.lines.splice(pos, o.length, ...written);
      if (runsToEnd) model.fin = !backslashAfterLastWritten(hunk.body);
    }
    d += n.length - o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s): Edit => {
    const oldPath = s.hasPair ? s.pairOld : (s.renameFrom ?? s.gitOld);
    const newPath = s.hasPair ? s.pairNew : (s.renameTo ?? s.gitNew);
    const creation = s.newFile || oldPath === DEVNULL;
    const deletion = s.delFile || newPath === DEVNULL;
    return (tree, moves) => {
      if (creation) {
        const p = newPath!;
        needSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        for (const h of s.hunks) for (const e of h.body) if (e.k === '+') out.push(e.t);
        let fin = true;
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const body = s.hunks[hi]!.body;
          for (let bi = body.length - 1; bi >= 0; bi--) {
            if (body[bi]!.k === '+') {
              fin = body[bi + 1]?.k !== '\\';
              break outer;
            }
          }
        }
        tree.now.set(p, out.length === 0 ? '' : toText({ lines: out, br: '\n', fin }));
        return;
      }
      if (deletion) {
        const p = oldPath!;
        needSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const from = oldPath!;
      const to = newPath!;
      needSafe(from);
      if (to !== from) needSafe(to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
      const model = toModel(before);
      applyHunks(model, s.hunks, strict, from);
      tree.now.set(to, toText(model));
      if (to !== from) {
        tree.now.set(from, null);
        moves.push([from, to]);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b): Edit => {
    return (tree) => {
      needSafe(b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : toText({ lines: [...b.newLines], br: '\n', fin: true }));
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const model = toModel(before);
      const found = findTier(model.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.occ[0]!;
      const ctx = b.newLines.map(() => -1);
      const written = buildNew(b.newLines, ctx, model.lines, pos, b.oldLines, found.tier);
      model.lines.splice(pos, b.oldLines.length, ...written);
      tree.now.set(b.path, toText(model));
    };
  });
}

/** Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  body: Array<{ k: string; t: string }>;
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '] as const;

function vStart(line: string): { kind: VSection['kind']; path: string } | null {
  for (const pre of V_STARTS) {
    if (line.startsWith(pre)) {
      const kind = pre === V_STARTS[0] ? 'add' : pre === V_STARTS[1] ? 'del' : 'upd';
      return { kind, path: line.slice(pre.length).trim() };
    }
  }
  return null;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const st = vStart(lines[i]!);
    if (st === null) {
      if (blank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind: st.kind, path: st.path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    if (st.kind === 'add') {
      const raw: string[] = [];
      while (i < last && vStart(lines[i]!) === null) {
        const l = lines[i]!;
        if (l.startsWith('+')) raw.push(l.slice(1));
        else if (l === '') raw.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sec.addLines = raw;
    } else if (st.kind === 'del') {
      while (i < last && vStart(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      let chunk: VChunk | null = null;
      let firstLine = true;
      const newChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, body: [], eof: false };
        sec.chunks.push(c);
        chunk = c;
        return c;
      };
      while (i < last && vStart(lines[i]!) === null) {
        const l = lines[i]!;
        if (firstLine && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice(13).trim();
          i += 1;
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          newChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) newChunk(null);
          chunk!.eof = true;
          chunk = null;
          i += 1;
          continue;
        }
        const c = l[0];
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) newChunk(null);
          chunk!.body.push({ k: l === '' ? ' ' : c!, t: l === '' ? '' : l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0) {
          const e = lastChunk.body[lastChunk.body.length - 1]!;
          if (e.k === ' ' && e.t === '') lastChunk.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s): Edit => {
    return (tree, moves) => {
      needSafe(s.path);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.addLines.length === 0 ? '' : toText({ lines: [...s.addLines], br: '\n', fin: true }));
        return;
      }
      if (s.kind === 'del') {
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
        return;
      }
      if (s.moveTo !== null) needSafe(s.moveTo);
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const model = toModel(before);
      let cursor = 0;
      for (const chunk of s.chunks) {
        if (chunk.anchor !== null) {
          let at = -1;
          for (const t of tiersOf(strict)) {
            for (let j = cursor; j < model.lines.length; j++) {
              if (eqAt(t, model.lines[j]!, chunk.anchor)) {
                at = j;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', s.path);
          cursor = at + 1;
        }
        const { o, n, ctx } = splitBody(chunk.body);
        if (o.length === 0) {
          const p = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
          model.lines.splice(p, 0, ...n);
          cursor = p + n.length;
        } else {
          let hit: { tier: number; occ: number[] } | null = null;
          for (const t of tiersOf(strict)) {
            let occ = occurrences(model.lines, o, t, cursor);
            if (chunk.eof) occ = occ.filter((x) => x + o.length === model.lines.length);
            if (occ.length > 0) {
              hit = { tier: t, occ };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', s.path);
          const pos = hit.occ[0]!;
          const written = buildNew(n, ctx, model.lines, pos, o, hit.tier);
          model.lines.splice(pos, o.length, ...written);
          cursor = pos + written.length;
        }
      }
      const text = toText(model);
      if (s.moveTo !== null) {
        tree.now.set(s.moveTo, text);
        tree.now.set(s.path, null);
        moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, text);
      }
    };
  });
}

/** Section 9: JSON edits. */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = toModel(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, toText(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 4: detecting the format. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const allMoves: Moves = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves: Moves = [];
    try {
      edit(tree, moves);
      allMoves.push(...moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [from, to] of allMoves) {
    const a = changed.get(from);
    const b = changed.get(to);
    if (a !== undefined && b !== undefined && a.was !== null && a.now === null && b.was === null && b.now !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      used.add(from);
      used.add(to);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
