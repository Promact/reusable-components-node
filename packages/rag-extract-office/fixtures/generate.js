'use strict';
// Builds tiny DOCX/XLSX/PPTX fixtures from text written for this repo. Run: npm run fixtures -w @promact/rag-extract-office
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const out = __dirname;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

async function save(zip, name) {
  fs.writeFileSync(path.join(out, name), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function docx() {
  const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${esc(t)}</w:t></w:r></w:p>`;
  const li = (t) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${esc(t)}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const row = (cs) => `<w:tr>${cs.map(cell).join('')}</w:tr>`;
  const body = [
    p('Fixture Handbook', 'Heading1'),
    p('This paragraph describes the onboarding process for new engineers.'),
    p('Setup', 'Heading2'),
    li('Install Node'),
    li('Clone the repository'),
    `<w:tbl>${row(['Tool', 'Purpose'])}${row(['npm', 'packages'])}${row(['jest', 'tests'])}</w:tbl>`,
    p('Closing remarks end the document.'),
  ].join('');
  const styles = `${CT}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style></w:styles>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file('word/styles.xml', styles);
  zip.file('word/numbering.xml', `${CT}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/document.xml', `${CT}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  await save(zip, 'sample.docx');
}

async function xlsx() {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('Inventory');
  a.addRow(['Item', 'Qty', 'Price']);
  a.addRow(['Widget', 10, 2.5]);
  a.addRow(['Gadget', 3, 9]);
  const b = wb.addWorksheet('Notes');
  b.addRow(['Owner', 'Comment']);
  b.addRow(['Asha', 'Reorder gadgets in March']);
  wb.addWorksheet('Empty');
  const h = wb.addWorksheet('Secret');
  h.addRow(['hidden']);
  h.state = 'hidden';
  fs.writeFileSync(path.join(out, 'sample.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
}

async function pptx() {
  const sp = (type, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const slide = (shapes) => `${CT}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
  const notes = (t) => slide(sp('body', [t])).replace('<p:sld ', '<p:notes ').replace('</p:sld>', '</p:notes>');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  // Written out of order on purpose: slide10 must sort after slide2.
  zip.file('ppt/slides/slide10.xml', slide(sp('title', ['Wrap Up']) + sp(null, ['Questions welcome'])));
  zip.file('ppt/slides/slide1.xml', slide(sp('ctrTitle', ['Quarterly Review']) + sp(null, ['Prepared by the platform team'])));
  zip.file('ppt/slides/slide2.xml', slide(sp(null, ['Untitled slide body'])));
  zip.file('ppt/notesSlides/notesSlide1.xml', notes('Mention the migration first'));
  await save(zip, 'sample.pptx');
}

Promise.all([docx(), xlsx(), pptx()]).then(() => console.log('fixtures written'));
