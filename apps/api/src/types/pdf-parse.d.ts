declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    text: string;
    version: string;
  }

  function pdfParse(
    dataBuffer: Buffer,
    options?: { max?: number; [key: string]: unknown }
  ): Promise<PdfData>;

  export default pdfParse;
}
