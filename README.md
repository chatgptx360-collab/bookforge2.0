# BookForge

A manuscript file converter, e-reader and narrator. Drop in DOCX, PDF, EPUB, TXT
or RTF files and get clean conversions back — or load a manuscript, edit it as
structured sections, read it in a typeset reader, and turn it into an audiobook.

- **File Converter** (`/converter`) — multi-file drag & drop, per-file progress,
  sequential conversion, automatic downloads and a "Download All (ZIP)" batch.
  EPUB targets take a cover image and store metadata, and every EPUB is checked
  structurally before it reaches you.
- **Reader & Editor** (`/reader`) — server-side parsing into title page, copyright
  page, table of contents and chapters; four editor themes, three typefaces, font
  sizing, split-at-cursor, word/character counts; export to TXT, server DOCX, or a
  KDP-layout DOCX built entirely in the browser.
- **Audiobook Studio** (`/audiobook`) — upload a manuscript, choose a narrator,
  and it is read chapter by chapter into downloadable WAV or MP3. See **Speech**
  below.
- **TTS Studio** (`/speech`) — paste any passage, choose a narrator and a
  delivery, and get audio back as WAV or MP3.
- **Reader** — a full e-reader, not a scroll view: paginated spreads (two pages on
  wide screens, one on mobile), four themes, four typefaces, size/spacing/margin
  controls, table of contents with per-chapter time estimates, in-book search,
  bookmarks, four-colour highlights with notes, read-aloud, immersive mode,
  keyboard shortcuts, and resume-where-you-left-off. See **Reader** below.

## Stack

React 19 · TypeScript · Vite 6 · Tailwind CSS v4 · Motion · lucide-react ·
Express 4 · mammoth · pdf-parse · pdf-lib · docx · adm-zip · multer ·
`@google/genai` · JSZip · lamejs · kokoro-js (Transformers.js). Deploys to Vercel
as a serverless function at `/api`.

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
| `npm run build` | `vite build` then bundles `server.ts` → `server-build/server.cjs` |
| `npm start` | Serves the built client (`dist/`) and the API |
| `npm test` | Builds the server bundle and runs the conversion test suite |
| `npm run lint` | `tsc --noEmit` |
| `npm run clean` | Removes `dist/` and `server-build/` (cross-platform, no `rm -rf`) |

All scripts are OS-agnostic — `clean` uses Node's `fs.rmSync`, and `start` uses
`cross-env` to set `NODE_ENV`, so Windows, macOS and Linux behave identically.

**Node.js:** v22 LTS or v24 (`engines: >=22.0.0`). If native modules
(`lightningcss`, `esbuild`, `rollup`) fail to load with an ABI error such as
"not a valid Win32 application", the installed binaries were built for a
different Node ABI — reinstall on Node 22 LTS.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | optional | Gemini speech and the reader's lookup. Kokoro speech needs no key at all |
| `OPENROUTER_API_KEY` | optional | Text-route fallback used when Gemini is absent, failing or out of quota |
| `GEMINI_MODELS` | optional | Comma-separated rotation list for quota failures |
| `GEMINI_TTS_MODEL` | optional | Defaults to `gemini-2.5-flash-preview-tts` |
| `OPENROUTER_MODEL` | optional | Defaults to `google/gemini-2.5-flash` |
| `AI_RATE_LIMIT` | optional | Text AI calls per IP per hour (default 40) |
| `TTS_RATE_LIMIT` | optional | Speech calls per IP per hour (default 4000 — a book is thousands of passages) |
| `CONVERT_RATE_LIMIT` | optional | Conversions per IP per hour (default 120) |
| `PORT` | optional | Defaults to `3000` |

Conversion, parsing and all DOCX/EPUB/PDF/RTF export routes need **no** API key.
AI routes return HTTP 503 with a clear message when no provider is configured.

**Provider selection.** Gemini is used when `GEMINI_API_KEY` is present. If a
call fails or every model in the rotation is exhausted and `OPENROUTER_API_KEY`
is also set, the request falls back to OpenRouter automatically. With only
`OPENROUTER_API_KEY`, every text route uses OpenRouter directly — but **speech
needs Gemini**, since OpenRouter exposes no equivalent audio modality.
`GET /api/health` reports which provider is active, whether a fallback is armed,
and which speech model is in use.

## API

Mounted at `/api`, all `POST` unless noted.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | — | Status, Node version, active AI provider |
| `/api/book/parse-file` | multipart `file` | `{ title, author, sections[], wordCount }` |
| `/api/book/convert` | multipart `file`, `targetFormat`, optional `coverImage` and EPUB metadata | Converted file download, plus an `X-Epub-Valid` header for EPUB targets |
| `/api/book/validate-epub` | multipart `file` | `{ valid, errors[], warnings[] }` |
| `/api/book/export-custom-docx` | `{ title, subtitle, author, chapters[] }` | DOCX |
| `/api/book/export-docx` | Book project JSON | KDP-layout DOCX with front/back matter |
| `/api/book/lookup` | `{ text, context?, targetLanguage? }` | `{ explanation }` for the reader's lookup |
| `GET /api/tts/voices` | — | `{ voices[], model, available, format }` |
| `/api/tts/plan` | `{ text, maxChars? }` | `{ chunks[], characters, estimatedSeconds }` |
| `/api/tts/speak` | `{ text, voice?, style? }` — `voice` is the model id | `{ audioBase64, mimeType, sampleRate }` — raw 16-bit PCM; 429 with `retryAfterSeconds` and `quotaScope` when throttled |

Uploads are capped at 25 MB; oversized files get a 413 with a readable message.
`/api/tts/speak` rejects passages over 4,500 characters with a 413 telling you to
split them — `/api/tts/plan` does that for you.

## Reader

The reader is the part users spend their time in, so it behaves like a commercial
e-reader rather than a styled scroll container.

| Area | What it does |
| --- | --- |
| Layout | CSS multi-column pagination with a clipping box sized to exactly one spread — two facing pages on wide screens, one on mobile. Switchable to continuous scrolling. |
| Typography | Four typefaces, 14–30 px, five line-height and five margin presets, justified or ragged-right, drop caps, ❦ scene breaks |
| Themes | Paper, Sepia, Night, Black (OLED) |
| Navigation | Contents panel with per-chapter word counts and time estimates, in-book search with context snippets, page turns by key/click zone/footer arrows |
| Annotations | Bookmarks and four-colour highlights with attached notes, listed in a side panel, click to jump |
| Progress | Percent read, time left in chapter and in book (adjustable wpm), page X of Y, chapter ticks on the progress bar |
| Narration | Sentence-level delivery with narrator pacing: breath at paragraph ends, a real gap at scene breaks, a slower read into chapter headings, and a lift for dialogue and questions. Voices are ranked so neural ones default to the top; pace and pitch are adjustable and persist |
| Extras | Immersive mode, dictionary/context lookup on any selection (needs an AI key), full keyboard control with a `?` shortcut sheet |

State is per book — position, bookmarks, highlights and notes are keyed by
title + author in `localStorage`, and the 25 most recent books are retained.
Typography settings are global.

## Speech

Both speech views run on Gemini's TTS models through the same three routes, and
both hand you a finished file rather than a stream you have to capture.

**Two engines.** *Kokoro* is the default: an 82M-parameter Apache-2.0 model that
runs entirely in the browser through WebGPU, falling back to WASM. Nothing is
sent anywhere, there is no key and no quota, and a whole book costs nothing —
which is the point, since a book is thousands of passages and any hosted API
bills or throttles every one of them. The model downloads once (~90 MB on
WebGPU's fp32 build, ~26 MB on the quantised WASM one) and the browser caches
it. *Gemini* remains available for directed delivery. The choice persists, and
the picker, previews and downloads work identically either way.

Kokoro takes a voice and a speed and nothing else, so the Delivery box is hidden
when it is selected rather than left there silently ignoring what you type.
Twenty-eight voices, American and British, gendered in their own ids
(`af_heart`, `bm_george`) and shown under their names — Heart, Michael, Emma,
George.

**Thirty Gemini narrators, described.** `GET /api/tts/voices` returns the prebuilt voice
catalogue: a character note, a timbre (warm / clear / bright / deep), whether the
voice reads male or female, and the concrete jobs it suits — audiobook
narration, podcast, documentary, trailer, children's books and so on. Each row
carries a ♂/♀ icon beside its play button, and the list filters by gender or
timbre. Every voice previews on a fixed line, so you hear a narrator before
committing a book to them.

Voices are listed under human names — Clara, Marcus, Ava, Theo — so the gender
is obvious from the name without decoding Google's star catalogue. The model's
own id (`Sulafat`, `Orus`, `Achernar`) stays visible on each row and is what
every request carries; `voice` in a request body is always the id, and a display
name is rejected with a 400.

**Delivery is directed, not dialled.** These models take direction in prose, so
the style box is passed as an instruction ahead of the passage — "read this
warmly and unhurriedly, like an audiobook narrator", or anything you write
yourself. The instruction is never spoken.

**Long text is split before it is spoken.** A single request is bounded, so
`/api/tts/plan` breaks text at paragraph boundaries first and sentence
boundaries only when a paragraph is itself too long — no request is ever cut
mid-thought. Audiobook chapters get their title read first (optional), 0.4 s
between passages, and a 0.8 s beat at the end so chapters do not run together.

**The model runs in a Web Worker.** ONNX Runtime's WASM backend executes
inference synchronously on the thread that calls it, so running it on the page
froze the whole tab for the length of every passage — no repainting, no
progress, and a Stop button that could not be clicked. A book is thousands of
passages, which makes that unusable rather than merely rough. The worker keeps
the model loaded between passages and hands back the audio buffer without
copying it.

**Assembly happens in the browser.** The model returns raw 16-bit PCM per
passage; the client concatenates it, writes a canonical 44-byte WAV header, and
encodes MP3 on demand with lamejs (loaded lazily — most sessions never ask for
it). Keeping this client-side is what makes book-length audio possible at all:
neither the function timeout nor the response size caps how long a book can be.

**Nothing is lost to a refresh.** Both views checkpoint themselves to IndexedDB
as they go — no button, nothing to remember. Reload mid-book and the manuscript,
the narrator, the delivery and every finished chapter come straight back,
playable and downloadable; the run picks up where it stopped instead of
re-spending the quota it already used. IndexedDB rather than localStorage
because the payload is audio: one chapter is megabytes, and localStorage caps
out around five for the entire origin.

**Being throttled is not the same as being out.** A per-minute window is worth
waiting for; a daily allowance is not. Provider 429s bury that distinction in a
`quotaId` field inside a wall of nested JSON, so the server parses it out and
says which it is. A per-minute limit is waited out with a visible countdown and
the run continues. A daily limit stops immediately — the API still suggests a
retry delay, but waiting 30 seconds for an allowance that refills tomorrow would
waste the time and fail anyway — and the message says what the limit was and
that Google's quotas reset at midnight Pacific. Either way the run stops rather
than failing every remaining chapter, and what was narrated is kept.

Throttling and breakage also get separate budgets: a quota window is sat through
several times, while a 5xx is retried twice and then reported, so a real failure
surfaces in seconds instead of after minutes of silent retrying.

**You choose what gets read.** A manuscript parses into front matter and
chapters, and not all of it belongs in an audiobook — a table of contents read
aloud is just a list of numbers, so it starts unticked while everything else
starts in. Every section has a checkbox, with *Everything*, *Chapters only* and
*Nothing* as shortcuts. Progress, packaging and the ZIP all count the selection
rather than the file, and the selection is saved with the rest of the run.

**Any section can be redone on its own.** A chapter can come out wrong — a
mispronunciation, a clipped passage, or simply the wrong narrator decided after
hearing it — and re-running the whole book to fix one of them is no answer.
Every finished section carries a redo beside its download links, and a failed
one carries a retry; either re-speaks that section alone, replaces its audio in
place and leaves the rest of the book untouched.

**A failed chapter does not end the run.** Chapters are narrated in order, and
one that fails is marked and skipped; the rest continue and the failures can be
retried afterwards. Download any chapter as WAV or MP3, or the whole book as a
ZIP of either.

**Errors say what happened.** When a platform fails outside the handler it
answers with an HTML page, and parsing that as JSON used to report
`Unexpected token 'A'`. Responses are read as text first, so the message names
the status and what the server actually said.

## Conversion notes

- **EPUB output is always EPUB 3.0** — the version KDP, Apple Books and Kobo
  require — and passes EPUBCheck 5.2.1 with zero errors or warnings. The
  package element declares `version="3.0"`, and the built-in validator reports
  the declared version, fails anything that is not 3.0, and flags EPUB 2
  leftovers (`<guide>`, a spine `toc` attribute, a stray NCX). The converter
  shows the result as an "EPUB 3.0 valid" badge on each download. No NCX; a `nav.xhtml` with `epub:type="toc"` plus a landmarks nav; a
  stylesheet; and a `mimetype` entry written first and stored uncompressed. The
  archive is produced by a small purpose-built ZIP writer (`createZipArchive`)
  because `adm-zip` cannot emit a stored entry.
- **PDF output** uses pdf-lib's standard Helvetica, which only encodes WinAnsi.
  Typographic characters (curly quotes, dashes, ellipses, ligatures) are mapped to
  safe equivalents and anything else is dropped, so a manuscript with smart quotes
  or a stray ❦ renders instead of throwing. Non-Latin scripts are not preserved in
  PDF output — convert to DOCX or EPUB for those.
- **Formatting survives conversion.** DOCX and EPUB are read into a styled block
  model (headings with levels, paragraphs, quotes, list items, scene breaks, and
  runs carrying bold/italic), and every generator writes from it. A bold word in
  a DOCX stays bold in the EPUB, the RTF and the PDF.
- **PDF input is reflowed.** pdf-parse returns one line per printed line; the
  extractor strips page markers and running heads, repairs hyphenation across
  breaks, and rejoins wrapped lines into paragraphs.
- **Uploads are identified by their bytes**, not their extension, and ZIP
  containers are checked for entry count, uncompressed size and compression
  ratio before anything is expanded.
- **Chapter detection** recognises `Chapter 7`, `Part II`, `Chapter Three`,
  markdown headings, and named sections (Prologue, Epilogue, Introduction …), while
  rejecting dot-leader table-of-contents lines that look like headings.

## Deployment (Vercel)

```bash
vercel --prod --yes
```

`vercel.json` runs `npm run build`, publishes `dist/`, rewrites `/api/(.*)` to the
serverless function, and rewrites every other path to `/index.html` so client-side
routes such as `/reader` survive a hard navigation. (Vercel applies rewrites after
the filesystem check, so real assets still win.) `api/index.mjs` installs inert
`DOMMatrix`, `ImageData` and `Path2D` shims — pdf-lib and pdf-parse probe for them
at import time — then imports the bundled Express app.

The server bundle is emitted to `server-build/`, deliberately **outside** the
published `dist/` directory: anything inside `dist/` is served as a static asset,
so building there would make `server.cjs` and its sourcemap publicly downloadable.

## Project layout

```
api/index.mjs              Vercel serverless entry (DOM shims + bundled app)
server-build/server.cjs    Built server bundle (git-ignored, never published)
server.ts                  Express app: every API route + all conversion logic
src/App.tsx                History-API router: converter | reader | audiobook | speech
src/components/            Sidebar, ConverterPanel, ReaderEditorPanel, BookReader
src/components/AudiobookPanel.tsx  Manuscript → chapter-by-chapter narration
src/components/TtsStudioPanel.tsx  Paste text → speech
src/components/tts/        Voice catalogue hook and picker with previews
src/components/reader/     Pagination content, panels, themes, book model
src/utils/audio.ts         PCM stitching, WAV writer, lazy MP3 encoder
src/utils/speech.ts        Engine router: local Kokoro or hosted Gemini
src/utils/kokoro.ts        In-browser Kokoro: device pick, model load, PCM out
src/utils/kokoroVoices.ts  Kokoro catalogue (no model code, so it stays light)
src/utils/sessionStore.ts  IndexedDB autosave for both speech views
src/utils/readerStore.ts   Per-book position, bookmarks, highlights, settings
src/utils/docxExporter.ts  Client-side KDP DOCX builder (lazy-loaded)
tests/conversion.test.mjs  Round-trip and format-validity tests
```

## Tests

```bash
npm test
```

CI runs the same suite on Node 22 and 24, fails if the server bundle ever lands
in the published `dist/`, and validates a generated EPUB with EPUBCheck 5.2.1.

Covers manuscript structure parsing, EPUB 3.0 package validity (mimetype offset and
storage method, manifest/spine integrity, no NCX), DOCX/PDF/RTF round-trips through
the extractors, the ZIP writer, entity decoding, JSON self-healing, and speech
chunk planning (no chunk over the limit, no text lost, sentence-boundary splits).
