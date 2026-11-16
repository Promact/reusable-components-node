import ExcelJS from 'exceljs';
import { DocumentElement } from '@promact/rag-core';

/** XLSX -> one heading (sheet name) + one table (first non-empty row is the header) per visible sheet. */
export async function extractXlsx(buf: Buffer): Promise<{ elements: DocumentElement[]; dropped: number }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const elements: DocumentElement[] = [];
  let dropped = 0;
  for (const sheet of wb.worksheets) {
    const rows: string[][] = [];
    if (sheet.state === 'visible') {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c++) cells.push(row.getCell(c).text.trim());
        if (cells.some(Boolean)) rows.push(cells);
      });
    }
    if (rows.length === 0) {
      dropped++;
      continue;
    }
    const [header, ...body] = rows;
    elements.push({ kind: 'heading', level: 1, text: sheet.name }, { kind: 'table', header, rows: body });
  }
  return { elements, dropped };
}
