import { DocumentElement } from '@promact/rag-core';

/** One positioned text run as reported by pdf.js (PDF user space: y grows upwards). */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface PageInput {
  page: number;
  width: number;
  height: number;
  runs: TextRun[];
}

interface Seg {
  x: number;
  end: number;
  text: string;
}

interface Line {
  page: number;
  y: number;
  size: number;
  x: number;
  segs: Seg[];
  text: string;
  margin: boolean;
}

export interface LayoutOptions {
  /** Pages with fewer non-space characters than this are flagged for OCR. */
  minCharsPerPage: number;
}

export interface LayoutResult {
  elements: DocumentElement[];
  pagesNeedingOcr: number[];
}

const MARGIN_BAND = 0.08;
const CELL_GAP = 1.5; // gap (in font sizes) that separates two table cells
const ROW_TOLERANCE = 0.5; // runs whose baselines differ by less than this (in font sizes) share a row
const PARAGRAPH_GAP = 1.7; // baseline distance (in font sizes) above which a new paragraph starts
const COLUMN_ALIGN = 8; // max x difference (points) for cells to count as one table column
const BULLET = /^(?:[•◦▪●‣*-]|\d{1,3}[.)])\s+/;

function makeLine(page: PageInput, runs: TextRun[]): Line {
  const sorted = [...runs].sort((a, b) => a.x - b.x);
  const segs: Seg[] = [];
  for (const r of sorted) {
    const end = r.x + r.width;
    const prev = segs[segs.length - 1];
    const gap = prev ? r.x - prev.end : 0;
    if (prev && gap <= CELL_GAP * r.size) {
      const space = gap > 0.1 * r.size && !/\s$/.test(prev.text) && !/^\s/.test(r.str) ? ' ' : '';
      prev.text += space + r.str;
      prev.end = Math.max(prev.end, end);
    } else {
      segs.push({ x: r.x, end, text: r.str });
    }
  }
  for (const s of segs) s.text = s.text.trim();
  const y = sorted[0].y;
  return {
    page: page.page,
    y,
    size: runs.reduce((m, r) => Math.max(m, r.size), 0),
    x: sorted[0].x,
    segs,
    text: segs.map((s) => s.text).join(' '),
    margin: y > page.height * (1 - MARGIN_BAND) || y < page.height * MARGIN_BAND,
  };
}

function groupRows(runs: TextRun[]): TextRun[][] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextRun[][] = [];
  for (const r of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - r.y) <= ROW_TOLERANCE * Math.min(row[0].size, r.size)) row.push(r);
    else rows.push([r]);
  }
  return rows;
}

/** Lines of one page in reading order; detects a two-column layout by x-clustering around the page's text midpoint. */
export function pageLines(page: PageInput): Line[] {
  const runs = page.runs.filter((r) => r.str.trim() !== '');
  if (runs.length === 0) return [];
  const rows = groupRows(runs);
  // No spread into Math.min/max: a page can carry more runs than the engine's argument limit.
  const minX = runs.reduce((m, r) => Math.min(m, r.x), Infinity);
  const maxX = runs.reduce((m, r) => Math.max(m, r.x + r.width), -Infinity);
  const mid = (minX + maxX) / 2;

  let crossing = 0;
  let split = 0;
  let sideChars = 0;
  let sideSegs = 0;
  const kinds = rows.map((row) => {
    if (row.some((r) => r.x < mid && r.x + r.width > mid)) {
      crossing++;
      return 'full' as const;
    }
    const left = row.filter((r) => r.x < mid);
    const right = row.filter((r) => r.x >= mid);
    if (left.length && right.length) {
      split++;
      for (const side of [left, right]) {
        sideChars += side.reduce((n, r) => n + r.str.trim().length, 0);
        sideSegs++;
      }
    }
    return 'side' as const;
  });
  const twoColumn = split >= 3 && crossing <= rows.length * 0.25 && sideChars / sideSegs >= 15;
  if (!twoColumn) return rows.map((row) => makeLine(page, row));

  const lines: Line[] = [];
  let leftBuf: Line[] = [];
  let rightBuf: Line[] = [];
  const flush = () => {
    for (const l of leftBuf) lines.push(l);
    for (const l of rightBuf) lines.push(l);
    leftBuf = [];
    rightBuf = [];
  };
  rows.forEach((row, i) => {
    if (kinds[i] === 'full') {
      flush();
      lines.push(makeLine(page, row));
      return;
    }
    const left = row.filter((r) => r.x < mid);
    const right = row.filter((r) => r.x >= mid);
    if (left.length) leftBuf.push(makeLine(page, left));
    if (right.length) rightBuf.push(makeLine(page, right));
  });
  flush();
  return lines;
}

function round(n: number): number {
  return Math.round(n * 2) / 2;
}

/** Most common font size, weighted by characters, over non-margin lines. */
function bodySize(lines: Line[]): number | undefined {
  const weight = new Map<number, number>();
  for (const l of lines) {
    if (l.margin) continue;
    const k = round(l.size);
    weight.set(k, (weight.get(k) ?? 0) + l.text.length);
  }
  let best: number | undefined;
  for (const [size, w] of weight) {
    if (best === undefined || w > (weight.get(best) as number)) best = size;
  }
  return best;
}

function tableRun(lines: Line[], from: number): number {
  const first = lines[from];
  const n = first.segs.length;
  if (n < 2 || first.margin) return 0;
  let end = from;
  while (end < lines.length) {
    const l = lines[end];
    if (l.margin || l.segs.length !== n || l.segs.some((s, i) => Math.abs(s.x - first.segs[i].x) > COLUMN_ALIGN)) break;
    end++;
  }
  return end - from >= 3 ? end - from : 0;
}

function paragraphOrList(lines: Line[], page: number): DocumentElement {
  if (lines.length >= 2 && lines.every((l) => BULLET.test(l.text))) {
    return { kind: 'list', items: lines.map((l) => l.text.replace(BULLET, '')), ordered: /^\d/.test(lines[0].text), page };
  }
  return { kind: 'paragraph', text: lines.map((l) => l.text).join('\n'), page };
}

/** Turns positioned text of all pages into elements (headings from font size, tables, paragraphs, lists). */
export function layoutDocument(pages: PageInput[], options: LayoutOptions): LayoutResult {
  const perPage = pages.map((p) => ({ page: p.page, lines: pageLines(p) }));
  const all = perPage.flatMap((p) => p.lines);
  const body = bodySize(all);
  const headingSizes =
    body === undefined
      ? []
      : [...new Set(all.filter((l) => !l.margin && round(l.size) >= body * 1.15 && l.text.length <= 150).map((l) => round(l.size)))].sort(
          (a, b) => b - a,
        );

  const elements: DocumentElement[] = [];
  const pagesNeedingOcr: number[] = [];
  for (const { page, lines } of perPage) {
    if (lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0) < options.minCharsPerPage) pagesNeedingOcr.push(page);
    let para: Line[] = [];
    const flush = () => {
      if (para.length) elements.push(paragraphOrList(para, page));
      para = [];
    };
    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (line.margin) {
        flush();
        elements.push({ kind: 'paragraph', text: line.text, page });
        i++;
        continue;
      }
      const hIndex = headingSizes.indexOf(round(line.size));
      if (hIndex >= 0 && line.text.length <= 150) {
        flush();
        elements.push({ kind: 'heading', level: Math.min(hIndex + 1, 6), text: line.text, page });
        i++;
        continue;
      }
      const rows = tableRun(lines, i);
      if (rows > 0) {
        flush();
        const cells = lines.slice(i, i + rows).map((l) => l.segs.map((s) => s.text));
        elements.push({ kind: 'table', header: cells[0], rows: cells.slice(1), page });
        i += rows;
        continue;
      }
      const prev = para[para.length - 1];
      // A larger y than the previous line means the reading order jumped to the next column.
      if (prev && (line.y > prev.y || prev.y - line.y > PARAGRAPH_GAP * Math.max(prev.size, line.size))) flush();
      para.push(line);
      i++;
    }
    flush();
  }
  return { elements, pagesNeedingOcr };
}
