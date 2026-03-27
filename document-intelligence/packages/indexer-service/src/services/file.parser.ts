import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';

/**
 * Extracts plain text from a document file.
 * Supports: TXT, MD, DOCX, PDF (via pdfjs text layer)
 */
export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return extractPdfText(filePath);
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  // TXT, MD and other plain-text formats
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Renders the first page of a PDF to a base64 PNG using node-canvas.
 * Falls back to text extraction if rendering fails (e.g. SMask / complex transparency).
 * For PNG/JPG images returns the raw file as base64.
 */
export async function extractImageBase64(
  filePath: string,
  mimeType: string,
): Promise<{ base64: string; usedFallbackText: boolean }> {
  if (mimeType !== 'application/pdf') {
    const buffer = await fs.readFile(filePath);
    return { base64: buffer.toString('base64'), usedFallbackText: false };
  }

  try {
    const base64 = await renderPdfPageToBase64(filePath);
    return { base64, usedFallbackText: false };
  } catch (err) {
    console.warn(
      `[file.parser] PDF visual render failed, falling back to text extraction: ${(err as Error).message}`,
    );
    const text = await extractPdfText(filePath);
    return { base64: Buffer.from(text).toString('base64'), usedFallbackText: true };
  }
}

// ── PDF text extraction ───────────────────────────────────────────────────────

async function extractPdfText(filePath: string): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await (pdfjsLib as any).getDocument({ data, verbosity: 0 }).promise;

  const pageTexts: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ');
    pageTexts.push(pageText);
  }

  await doc.destroy();
  return pageTexts.join('\n\n').trim();
}

// ── PDF visual rendering ──────────────────────────────────────────────────────

function buildNodeCanvasFactory(canvasModule: any) {
  return {
    create(width: number, height: number) {
      const canvas = canvasModule.createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndCtx: any, width: number, height: number) {
      canvasAndCtx.canvas.width  = width;
      canvasAndCtx.canvas.height = height;
    },
    destroy(canvasAndCtx: any) {
      canvasAndCtx.canvas.width  = 0;
      canvasAndCtx.canvas.height = 0;
      canvasAndCtx.canvas  = null;
      canvasAndCtx.context = null;
    },
  };
}

async function renderPdfPageToBase64(filePath: string): Promise<string> {
  const canvasModule = await import('canvas').catch(() => {
    throw new Error(
      'The "canvas" package is required for PDF rendering. Install it with: npm install canvas',
    );
  });

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const NodeCanvasFactory = buildNodeCanvasFactory(canvasModule);

  const data = new Uint8Array(await fs.readFile(filePath));

  const doc = await (pdfjsLib as any).getDocument({ data, verbosity: 0 }).promise;
  const page     = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });

  const canvasAndCtx = NodeCanvasFactory.create(viewport.width, viewport.height);

  await page.render({
    canvasContext:  canvasAndCtx.context,
    viewport,
    canvasFactory:  NodeCanvasFactory,  // required for SMask / soft-mask support
  } as any).promise;

  const buffer: Buffer = canvasAndCtx.canvas.toBuffer('image/png');

  NodeCanvasFactory.destroy(canvasAndCtx);
  await doc.destroy();

  return buffer.toString('base64');
}
