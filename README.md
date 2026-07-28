# BookForge

A manuscript file converter and reader/editor. Drop in DOCX, PDF, EPUB, TXT or RTF
files and get clean conversions back — or load a manuscript, edit it as structured
sections, and read it in a typeset reader.

- **File Converter** (`/converter`) — multi-file drag & drop, per-file progress,
  sequential conversion, automatic downloads and a "Download All (ZIP)" batch.
- **Reader & Editor** (`/reader`) — server-side parsing into title page, copyright
  page, table of contents and chapters; four editor themes, three typefaces, font
  sizing, split-at-cursor, word/character counts; export to TXT, server DOCX, or a
  KDP-layout DOCX built entirely in the browser.
- **Reader** — Georgia/Times serif prose, centred chapter headings, indented
  paragraphs (flush after scene breaks), ❦ fleurons, light/dark toggle and scroll
  bookmarks persisted in `localStorage`.

## Stack

React 19 · TypeScript · Vite 6 · Tailwind CSS v4 · Motion · lucide-react ·
Express 4 · mammoth · pdf-parse · pdf-lib · docx · adm-zip · multer ·
`@google/genai` · JSZip. Deploys to Vercel as a serverless function at `/api`.

## Getting started

```bash
npm install
cp .env.example .env      # optional — only the AI endpoints need keys
npm run dev               # http://localhost:3000
```

`npm run dev` runs `tsx server.ts`, which mounts Vite in middleware mode behind the
same Express app that serves the API, so the client and API share one origin.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Express + Vite dev server (HMR) |
| `npm run build` | `vite build` then bundles `server.ts` → `dist/server.cjs` |
| `npm start` | Serves the built client and API from `dist/` |
| `npm test` | Builds the server bundle and runs the conversion test suite |
| `npm run lint` | `tsc --noEmit` |
| `npm run clean` | Removes `dist/` (cross-platform, no `rm -rf`) |

All scripts are OS-agnostic — `clean` uses Node's `fs.rmSync`, and `start` uses
`cross-env` to set `NODE_ENV`, so Windows, macOS and Linux behave identically.

**Node.js:** v22 LTS or v24 (`engines: >=22.0.0`). If native modules
(`lightningcss`, `esbuild`, `rollup`) fail to load with an ABI error such as
"not a valid Win32 application", the installed binaries were built for a
different Node ABI — reinstall on Node 22 LTS.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | for AI routes | Translation, drafting, marketing copy, covers |
| `OPENROUTER_API_KEY` | optional | Fallback for the text routes when Gemini is absent |
| `GEMINI_MODELS` | optional | Comma-separated rotation list for quota failures |
| `GEMINI_IMAGE_MODEL` | optional | Defaults to `imagen-4.0-generate-001` |
| `PORT` | optional | Defaults to `3000` |

Conversion, parsing and all DOCX/EPUB/PDF/RTF export routes need **no** API key.
AI routes return HTTP 503 with a clear message when no provider is configured.

## API

Mounted at `/api`, all `POST` unless noted.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | — | Status, Node version, active AI provider |
| `/api/book/parse-file` | multipart `file` | `{ title, author, sections[], wordCount }` |
| `/api/book/convert` | multipart `file`, `targetFormat` | Converted file download |
| `/api/book/export-custom-docx` | `{ title, subtitle, author, chapters[] }` | DOCX |
| `/api/book/export-docx` | Book project JSON | KDP-layout DOCX with front/back matter |
| `/api/book/export-translated-docx` | `{ title, author, language, chapters[] }` | DOCX |
| `/api/book/translate-chunk` | `{ text, targetLanguage }` | `{ translatedText }` |
| `/api/book/enhance-draft` | `{ text, instruction?, intensity? }` | `{ enhancedText }` |
| `/api/book/analyze-discovery` | Concept answers | Development analysis |
| `/api/book/generate-outline` | Project brief | Chapter-by-chapter blueprint |
| `/api/book/generate-chapter` | `{ chapterOutline, … }` | `{ chapterText, … }` |
| `/api/book/generate-cover` | `{ title, genre, mood, … }` | `{ imageUrl }` (data URI) |
| `/api/author-empire/generate-titles` | `{ premise, genre, … }` | Title candidates |
| `/api/author-empire/generate-blurb` | `{ title, premise, … }` | Marketing package |
| `/api/author-empire/analyze-cover` | multipart `image` or `{ imageBase64 }` | Cover audit |

Uploads are capped at 25 MB; oversized files get a 413 with a readable message.

## Conversion notes

- **EPUB output is EPUB 3.0 and passes EPUBCheck 5.2.1 with zero errors or
  warnings.** No NCX; a `nav.xhtml` with `epub:type="toc"` plus a landmarks nav; a
  stylesheet; and a `mimetype` entry written first and stored uncompressed. The
  archive is produced by a small purpose-built ZIP writer (`createZipArchive`)
  because `adm-zip` cannot emit a stored entry.
- **PDF output** uses pdf-lib's standard Helvetica, which only encodes WinAnsi.
  Typographic characters (curly quotes, dashes, ellipses, ligatures) are mapped to
  safe equivalents and anything else is dropped, so a manuscript with smart quotes
  or a stray ❦ renders instead of throwing. Non-Latin scripts are not preserved in
  PDF output — convert to DOCX or EPUB for those.
- **Chapter detection** recognises `Chapter 7`, `Part II`, `Chapter Three`,
  markdown headings, and named sections (Prologue, Epilogue, Introduction …), while
  rejecting dot-leader table-of-contents lines that look like headings.

## Deployment (Vercel)

```bash
vercel --prod --yes
```

`vercel.json` runs `npm run build`, publishes `dist/`, and rewrites `/api/(.*)` to
the serverless function. `api/index.mjs` installs inert `DOMMatrix`, `ImageData`
and `Path2D` shims — pdf-lib and pdf-parse probe for them at import time — and then
imports the bundled Express app.

## Project layout

```
api/index.mjs              Vercel serverless entry (DOM shims + bundled app)
server.ts                  Express app: every API route + all conversion logic
src/App.tsx                History-API router: converter | reader
src/components/            Sidebar, ConverterPanel, ReaderEditorPanel, BookReader
src/utils/docxExporter.ts  Client-side KDP DOCX builder (lazy-loaded)
tests/conversion.test.mjs  Round-trip and format-validity tests
```

## Tests

```bash
npm test
```

Covers manuscript structure parsing, EPUB 3.0 package validity (mimetype offset and
storage method, manifest/spine integrity, no NCX), DOCX/PDF/RTF round-trips through
the extractors, the ZIP writer, entity decoding and JSON self-healing.
