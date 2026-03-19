const TEXT_DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt'] as const;
const DOCX_DOCUMENT_EXTENSIONS = ['docx'] as const;
const DOCX_DOCUMENT_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const SUPPORTED_DOCUMENT_ACCEPT = ['.pdf', '.docx', '.md', '.txt', '.markdown'].join(',');

export type SupportedDocumentType = 'pdf' | 'text' | 'docx';

export function getSupportedDocumentType(
  file: Pick<File, 'name' | 'type'>,
): SupportedDocumentType | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if ((TEXT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return 'text';
  }

  if (
    (DOCX_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ||
    (DOCX_DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    return 'docx';
  }

  if (ext === 'pdf' || file.type === 'application/pdf') {
    return 'pdf';
  }

  return null;
}

export async function readTextFileContent(file: Blob): Promise<string> {
  return file.text();
}

function normalizeExtractedDocumentText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
}

export async function readDocxTextContent(file: Blob): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return normalizeExtractedDocumentText(result.value);
}
