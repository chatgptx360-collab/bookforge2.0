/**
 * mammoth ships a browser bundle with no types of its own.
 *
 * Only the one call the converter makes is declared. Widening this to `any`
 * would hide a signature change behind a clean build, which is the failure
 * this file exists to prevent.
 */
declare module 'mammoth/mammoth.browser.js' {
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: { convertImage?: unknown },
  ): Promise<{ value: string }>;
  export const images: { imgElement(convert: () => Record<string, string>): unknown };
}
