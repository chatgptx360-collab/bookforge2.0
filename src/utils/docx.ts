/**
 * Unwrapping DOCX before it is sent.
 *
 * The deployed app sits behind a host that rejects request bodies over about
 * 4.5 MB at the edge — before any server code of ours runs, so no setting can
 * raise it. That put a hard ceiling on the converter, and a book with pictures
 * in it clears 4.5 MB easily: a user of this app uploaded twenty-three
 * manuscripts and seven came back.
 *
 * Almost none of that size is words. A DOCX is a zip of XML, fonts, thumbnails
 * and images, and the server throws all of it away except the markup mammoth
 * extracts. So the browser runs mammoth instead and posts the markup, which
 * for a full novel is a megabyte or two of HTML rather than tens of megabytes
 * of packaging. The server uses the very same library on the very same
 * content, so the conversion is unchanged — only the size of the request is.
 */

interface Mammoth {
  convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: { convertImage?: unknown },
  ): Promise<{ value: string }>;
  images: { imgElement(convert: () => Record<string, string>): unknown };
}

let loading: Promise<Mammoth> | null = null;

/**
 * Loads mammoth on first use.
 *
 * It is a third of a megabyte, and most visitors never convert a DOCX, so it
 * is kept out of the initial bundle.
 */
function load(): Promise<Mammoth> {
  loading ??= import('mammoth/mammoth.browser.js').then(
    (module) => ((module as { default?: Mammoth }).default ?? module) as unknown as Mammoth,
  );
  return loading;
}

export function isDocx(file: File): boolean {
  return /\.docx$/i.test(file.name);
}

/**
 * Extracts a DOCX to HTML here rather than on the server.
 *
 * Returns null when this cannot be done — a corrupt file, a document whose
 * content is entirely images, or a browser that fails to load the parser. The
 * caller then uploads the file as before, so the worst case is the behaviour
 * that existed before this path was added rather than a failed conversion.
 */
export async function extractDocxHtml(file: File): Promise<string | null> {
  if (!isDocx(file)) return null;
  try {
    const mammoth = await load();
    const { value } = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      {
        // Mammoth inlines every image as a base64 data URI by default, which
        // would make the markup *larger* than the file it replaces — a 20 MB
        // illustrated book became 27 MB of HTML and was rejected outright.
        // The server discards images anyway, so they are dropped here.
        convertImage: mammoth.images.imgElement(() => ({})),
      },
    );
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}
