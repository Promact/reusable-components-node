import { XMLParser } from 'fast-xml-parser';
import type { Entry, ZipFile } from 'yauzl';
import { DocumentElement } from '@promact/rag-core';
import { readEntry } from './zipGuard';

type N = Record<string, unknown>;
const ARRAYS = new Set(['p:sp', 'a:p', 'a:r', 'a:t']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, isArray: (n) => ARRAYS.has(n) });

const arr = (v: unknown): N[] => (v === undefined ? [] : (v as N[]));

function paragraphs(sp: N): string[] {
  const body = sp['p:txBody'] as N | undefined;
  if (!body) return [];
  return arr(body['a:p'])
    .map((p) => arr(p['a:r']).map((r) => arr(r['a:t'] as unknown).join('')).join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function shapes(xml: string): N[] {
  const doc = parser.parse(xml) as N;
  const tree = ((doc['p:sld'] ?? doc['p:notes']) as N)?.['p:cSld'] as N | undefined;
  return arr((tree?.['p:spTree'] as N | undefined)?.['p:sp']);
}

const phType = (sp: N): string | undefined =>
  (((sp['p:nvSpPr'] as N | undefined)?.['p:nvPr'] as N | undefined)?.['p:ph'] as N | undefined)?.['@_type'] as string | undefined;

const slideNo = (name: string) => Number(/slide(\d+)\.xml$/.exec(name)?.[1]);

/** PPTX -> one section per slide: heading (slide title, else "Slide N") then body paragraphs, optional notes. */
export async function extractPptx(
  zip: ZipFile,
  entries: Map<string, Entry>,
  includeNotes: boolean,
  check: () => void,
): Promise<{ elements: DocumentElement[]; slides: number }> {
  const slides = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  const elements: DocumentElement[] = [];
  for (const name of slides) {
    check();
    const n = slideNo(name);
    const titles: string[] = [];
    const body: string[] = [];
    for (const sp of shapes((await readEntry(zip, entries.get(name) as Entry)).toString('utf8'))) {
      (['title', 'ctrTitle'].includes(phType(sp) ?? '') ? titles : body).push(...paragraphs(sp));
    }
    elements.push({ kind: 'heading', level: 1, text: titles.join(' ') || `Slide ${n}`, page: n });
    for (const t of body) elements.push({ kind: 'paragraph', text: t, page: n });
    const notes = entries.get(`ppt/notesSlides/notesSlide${n}.xml`);
    if (includeNotes && notes) {
      const text = shapes((await readEntry(zip, notes)).toString('utf8'))
        .filter((sp) => phType(sp) === 'body')
        .flatMap(paragraphs)
        .join(' ');
      if (text) elements.push({ kind: 'paragraph', text: `Speaker notes: ${text}`, page: n });
    }
  }
  return { elements, slides: slides.length };
}
