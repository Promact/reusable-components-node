import { layoutDocument, PageInput, pageLines, TextRun } from './layout';

const H = 792;
const run = (str: string, x: number, top: number, size = 11, width = str.length * size * 0.5): TextRun => ({ str, x, y: H - top, width, size });
const page = (n: number, runs: TextRun[]): PageInput => ({ page: n, width: 612, height: H, runs });
const opts = { minCharsPerPage: 25 };

describe('pageLines', () => {
  it('returns nothing for blank runs', () => {
    expect(pageLines(page(1, [run('   ', 72, 100)]))).toEqual([]);
  });

  it('merges adjacent runs on a row, inserting a space only for a real gap', () => {
    const [line] = pageLines(page(1, [run('Hel', 72, 100, 10, 15), run('lo', 87, 100, 10, 10), run('world', 100, 100, 10, 25), run(' x', 125, 100, 10, 5)]));
    expect(line.text).toBe('Hello world x');
    expect(line.segs).toHaveLength(1);
  });

  it('splits far-apart runs into separate segments (table cells)', () => {
    const [line] = pageLines(page(1, [run('A', 72, 100), run('B', 300, 100)]));
    expect(line.segs.map((s) => s.text)).toEqual(['A', 'B']);
  });

  it('reads a two-column page column by column, with spanning lines as separators', () => {
    const l = (s: string, t: number) => run(s, 72, t, 11, 200);
    const r = (s: string, t: number) => run(s, 330, t, 11, 200);
    const lines = pageLines(
      page(1, [
        run('A spanning title across the whole page width here', 72, 60, 11, 470),
        l('left one is long enough', 100), r('right one is long enough', 100),
        l('left two is long enough', 116), r('right two is long enough', 116),
        l('left three is long enough', 132), r('right three is long enough', 132),
        l('left four is long enough', 148), r('right four is long enough', 148),
        l('left five is long enough', 164), r('right five is long enough', 164),
        run('A spanning footnote across the whole page width', 72, 300, 11, 470),
        l('left tail only text here', 320),
      ]),
    );
    expect(lines.map((x) => x.text)).toEqual([
      'A spanning title across the whole page width here',
      'left one is long enough', 'left two is long enough', 'left three is long enough', 'left four is long enough', 'left five is long enough',
      'right one is long enough', 'right two is long enough', 'right three is long enough', 'right four is long enough', 'right five is long enough',
      'A spanning footnote across the whole page width',
      'left tail only text here',
    ]);
  });

  it('does not treat a table with short cells as two columns', () => {
    const rows = [0, 1, 2, 3].flatMap((i) => [run('ab', 72, 100 + i * 20), run('cd', 400, 100 + i * 20)]);
    const lines = pageLines(page(1, rows));
    expect(lines).toHaveLength(4);
    expect(lines[0].segs).toHaveLength(2);
  });
});

describe('layoutDocument', () => {
  it('derives heading levels from distinct larger font sizes', () => {
    const { elements } = layoutDocument(
      [page(1, [run('Big Title', 72, 80, 24), run('Section', 72, 120, 16), run('Body text is here, long enough to dominate the page.', 72, 150)])],
      opts,
    );
    expect(elements).toEqual([
      { kind: 'heading', level: 1, text: 'Big Title', page: 1 },
      { kind: 'heading', level: 2, text: 'Section', page: 1 },
      { kind: 'paragraph', text: 'Body text is here, long enough to dominate the page.', page: 1 },
    ]);
  });

  it('keeps long large-font lines as paragraphs', () => {
    const long = 'x'.repeat(200);
    const { elements } = layoutDocument([page(1, [run(long, 72, 80, 14), run('Body text that is quite a bit longer than the other line.'.repeat(5), 72, 120)])], opts);
    expect(elements.every((e) => e.kind === 'paragraph')).toBe(true);
  });

  it('splits paragraphs on big vertical gaps and keeps margin lines separate', () => {
    const { elements } = layoutDocument(
      [page(1, [run('Header text', 72, 30), run('First line of body.', 72, 100), run('Second line of body.', 72, 114), run('Far away paragraph start.', 72, 200), run('Footer text', 72, 770)])],
      opts,
    );
    expect(elements.map((e) => (e.kind === 'paragraph' ? e.text : e.kind))).toEqual([
      'Header text',
      'First line of body.\nSecond line of body.',
      'Far away paragraph start.',
      'Footer text',
    ]);
  });

  it('detects bulleted and numbered lists, but not mixed lines', () => {
    const { elements } = layoutDocument(
      [
        page(1, [run('• first item here', 72, 100), run('• second item here', 72, 114), run('1. one', 72, 200), run('2) two', 72, 214), run('- dash', 72, 300), run('plain', 72, 314)]),
      ],
      { minCharsPerPage: 0 },
    );
    expect(elements[0]).toEqual({ kind: 'list', items: ['first item here', 'second item here'], ordered: false, page: 1 });
    expect(elements[1]).toMatchObject({ kind: 'list', items: ['one', 'two'], ordered: true });
    expect(elements[2]).toMatchObject({ kind: 'paragraph', text: '- dash\nplain' });
  });

  it('needs three aligned multi-cell rows for a table', () => {
    const row = (i: number, dx = 0) => [run('a' + i, 72, 100 + i * 20), run('b' + i, 300 + dx, 100 + i * 20)];
    const table = layoutDocument([page(1, [...row(0), ...row(1), ...row(2)])], { minCharsPerPage: 0 });
    expect(table.elements).toEqual([{ kind: 'table', header: ['a0', 'b0'], rows: [['a1', 'b1'], ['a2', 'b2']], page: 1 }]);
    const two = layoutDocument([page(1, [...row(0), ...row(1)])], { minCharsPerPage: 0 });
    expect(two.elements.every((e) => e.kind === 'paragraph')).toBe(true);
    const misaligned = layoutDocument([page(1, [...row(0), ...row(1, 50), ...row(2)])], { minCharsPerPage: 0 });
    expect(misaligned.elements.some((e) => e.kind === 'table')).toBe(false);
  });

  it('never treats margin lines as tables', () => {
    const { elements } = layoutDocument([page(1, [0, 1, 2].flatMap((i) => [run('a', 72, 20 + i * 5), run('b', 300, 20 + i * 5)]))], { minCharsPerPage: 0 });
    expect(elements.some((e) => e.kind === 'table')).toBe(false);
  });

  it('flags pages with little text for OCR and handles an empty document', () => {
    const r = layoutDocument([page(1, [run('Plenty of text on this page, enough to pass.', 72, 100)]), page(2, []), page(3, [run('tiny', 72, 100)])], opts);
    expect(r.pagesNeedingOcr).toEqual([2, 3]);
    expect(layoutDocument([], opts)).toEqual({ elements: [], pagesNeedingOcr: [] });
  });
});
