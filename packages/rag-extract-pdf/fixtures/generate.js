'use strict';
// Builds tiny PDF fixtures from text written for this repo. Run: npm run fixtures -w @promact/rag-extract-pdf
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const out = __dirname;
const W = 612;
const H = 792;

async function build(name, fn) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const newPage = () => {
    const page = doc.addPage([W, H]);
    // text(str, x, yFromTop, size, isBold)
    const text = (s, x, top, size = 11, b = false) =>
      page.drawText(s, { x, y: H - top, size, font: b ? bold : font, color: rgb(0, 0, 0) });
    return { page, text };
  };
  fn(newPage);
  fs.writeFileSync(path.join(out, name), await doc.save());
}

const LOREM = [
  'The onboarding process starts on the first Monday of each month.',
  'New engineers receive a laptop, an account and a mentor.',
  'Mentors meet their mentee twice a week during the first month.',
];

async function main() {
  await build('single-column.pdf', (newPage) => {
    const { text } = newPage();
    text('Engineering Handbook', 72, 90, 24, true);
    LOREM.forEach((l, i) => text(l, 72, 130 + i * 16));
    text('Tooling', 72, 220, 16, true);
    ['We use npm workspaces for every package.', 'Tests are written with Jest and run in CI.'].forEach((l, i) =>
      text(l, 72, 255 + i * 16),
    );
    text('Paragraph two starts here after a gap.', 72, 320);
    text('And it continues on the next line.', 72, 336);
  });

  await build('two-column.pdf', (newPage) => {
    const { text } = newPage();
    text('Left column line one about apples.', 72, 100);
    text('Left column line two about pears.', 72, 116);
    text('Left column line three about plums.', 72, 132);
    text('Right column line one about boats.', 330, 100);
    text('Right column line two about trains.', 330, 116);
    text('Right column line three about planes.', 330, 132);
  });

  await build('table.pdf', (newPage) => {
    const { text } = newPage();
    text('Price list', 72, 90, 18, true);
    text('Here is the current price list for all items.', 72, 125);
    const rows = [
      ['Item', 'Quantity', 'Price'],
      ['Widget', '10', '4.50'],
      ['Gadget', '25', '12.00'],
      ['Gizmo', '3', '99.99'],
    ];
    rows.forEach((r, i) => r.forEach((c, j) => text(c, 72 + j * 150, 170 + i * 20)));
    text('Prices exclude tax.', 72, 280);
  });

  await build('header-footer.pdf', (newPage) => {
    const bodies = [
      'Chapter one explains how the system stores documents.',
      'Chapter two explains how retrieval ranks the stored chunks.',
      'Chapter three explains how answers are cited to sources.',
      'Chapter four lists the known limitations of the design.',
    ];
    bodies.forEach((b, i) => {
      const { text } = newPage();
      text('Acme Corporation Confidential Handbook', 72, 40, 9);
      text(b, 72, 200);
      text(`Page ${i + 1} of ${bodies.length}`, 270, 760, 9);
    });
  });

  await build('toc.pdf', (newPage) => {
    let { text } = newPage();
    text('Contents', 72, 90, 20, true);
    [
      ['Introduction', 3],
      ['Architecture overview', 4],
      ['Operations', 6],
      ['Appendix', 9],
    ].forEach(([t, p], i) => text(`${t} ${'.'.repeat(30)} ${p}`, 72, 140 + i * 18));
    ({ text } = newPage());
    text('Introduction', 72, 90, 20, true);
    text('This guide introduces the product and its goals in plain words.', 72, 130);
  });

  await build('scanned.pdf', (newPage) => {
    let { text } = newPage();
    text('This first page has real text that can be extracted directly.', 72, 100);
    text('It contains a few full sentences so it is not flagged.', 72, 116);
    const second = newPage();
    // Image-only page: only a filled rectangle, no text operators.
    second.page.drawRectangle({ x: 72, y: 200, width: 400, height: 300, color: rgb(0.8, 0.8, 0.8) });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
