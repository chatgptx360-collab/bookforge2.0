import { useRef, useState } from 'react';
import { ImageIcon, Upload } from 'lucide-react';
import {
  CopyButton,
  DownloadTextButton,
  Field,
  Prose,
  ResultCard,
  RunButton,
  Select,
  TaskError,
  TextArea,
  TextInput,
  useAiTask,
} from './ui';

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese (Brazil)', 'Dutch', 'Polish',
  'Japanese', 'Korean', 'Simplified Chinese', 'Arabic', 'Hindi', 'Swahili', 'Yoruba',
];

// ---------------------------------------------------------------------------

export function TranslateTool() {
  const [text, setText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('Spanish');
  const [preserveFormatting, setPreserveFormatting] = useState(true);
  const { state, run } = useAiTask<{ translatedText: string; characterCount: number }>(
    '/api/book/translate-chunk',
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <Field label="Passage to translate" hint="Work in chunks of a few thousand words for the best fidelity.">
          <TextArea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste your prose here…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target language">
            <Select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Formatting">
            <Select
              value={preserveFormatting ? 'keep' : 'clean'}
              onChange={(e) => setPreserveFormatting(e.target.value === 'keep')}
            >
              <option value="keep">Keep breaks and headings</option>
              <option value="clean">Clean prose only</option>
            </Select>
          </Field>
        </div>
        <RunButton
          label="Translate"
          status={state.status}
          disabled={!text.trim()}
          onClick={() => run({ text, targetLanguage, preserveFormatting })}
        />
        <TaskError state={state} />
      </div>

      <div className="space-y-4">
        {state.data ? (
          <ResultCard
            title={`${targetLanguage} · ${state.data.characterCount.toLocaleString()} characters`}
            actions={
              <>
                <CopyButton value={state.data.translatedText} />
                <DownloadTextButton value={state.data.translatedText} fileName={`translation_${targetLanguage}.txt`} />
              </>
            }
          >
            <Prose text={state.data.translatedText} />
          </ResultCard>
        ) : (
          <EmptyPane label="The translation will appear here." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function EnhanceTool() {
  const [text, setText] = useState('');
  const [intensity, setIntensity] = useState('balanced');
  const [tone, setTone] = useState('');
  const [instruction, setInstruction] = useState('');
  const { state, run } = useAiTask<{ enhancedText: string; originalWordCount: number; enhancedWordCount: number }>(
    '/api/book/enhance-draft',
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <Field label="Draft">
          <TextArea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the passage you want edited…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Intensity">
            <Select value={intensity} onChange={(e) => setIntensity(e.target.value)}>
              <option value="light">Light — mechanics only</option>
              <option value="balanced">Balanced — tighten prose</option>
              <option value="heavy">Heavy — rewrite for impact</option>
            </Select>
          </Field>
          <Field label="Target tone">
            <TextInput value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. wry, restrained" />
          </Field>
        </div>
        <Field label="Instruction" hint="Anything the editor must respect — names, terminology, register.">
          <TextInput
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. keep the present tense and never rename the ship"
          />
        </Field>
        <RunButton
          label="Line edit"
          status={state.status}
          disabled={!text.trim()}
          onClick={() => run({ text, intensity, tone, instruction })}
        />
        <TaskError state={state} />
      </div>

      <div className="space-y-4">
        {state.data ? (
          <ResultCard
            title={`${state.data.originalWordCount} → ${state.data.enhancedWordCount} words`}
            actions={
              <>
                <CopyButton value={state.data.enhancedText} />
                <DownloadTextButton value={state.data.enhancedText} fileName="edited_draft.txt" />
              </>
            }
          >
            <Prose text={state.data.enhancedText} />
          </ResultCard>
        ) : (
          <EmptyPane label="The edited prose will appear here." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TitleCandidate {
  title: string;
  subtitle: string;
  angle: string;
  rationale: string;
  searchAppeal: number;
}

export function TitlesTool() {
  const [form, setForm] = useState({ premise: '', genre: '', audience: '', tone: '', keywords: '' });
  const { state, run } = useAiTask<{ titles: TitleCandidate[] }>('/api/author-empire/generate-titles');
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <Field label="Premise">
          <TextArea rows={6} value={form.premise} onChange={(e) => set('premise')(e.target.value)} placeholder="What is the book about?" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Genre">
            <TextInput value={form.genre} onChange={(e) => set('genre')(e.target.value)} placeholder="e.g. literary thriller" />
          </Field>
          <Field label="Audience">
            <TextInput value={form.audience} onChange={(e) => set('audience')(e.target.value)} placeholder="e.g. adult book-club readers" />
          </Field>
          <Field label="Tone">
            <TextInput value={form.tone} onChange={(e) => set('tone')(e.target.value)} placeholder="e.g. tense, wry" />
          </Field>
          <Field label="Keywords">
            <TextInput value={form.keywords} onChange={(e) => set('keywords')(e.target.value)} placeholder="comma separated" />
          </Field>
        </div>
        <RunButton
          label="Generate titles"
          status={state.status}
          disabled={!form.premise.trim()}
          onClick={() => run({ ...form, keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean) })}
        />
        <TaskError state={state} />
      </div>

      <div className="space-y-3">
        {state.data?.titles?.length ? (
          state.data.titles.map((candidate, index) => (
            <div key={index} className="bg-[#111114] border border-[#27272A] rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="font-display font-bold text-white text-sm">{candidate.title}</h4>
                  {candidate.subtitle && <p className="text-xs text-[#A1A1AA] mt-0.5">{candidate.subtitle}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/20 rounded px-1.5 py-0.5">
                    {candidate.searchAppeal}/10
                  </span>
                  <CopyButton value={`${candidate.title}${candidate.subtitle ? `: ${candidate.subtitle}` : ''}`} label="" />
                </div>
              </div>
              <p className="text-[11px] text-[#71717A] mt-2 leading-relaxed">
                <span className="text-[#A1A1AA] font-medium">{candidate.angle}</span> — {candidate.rationale}
              </p>
            </div>
          ))
        ) : (
          <EmptyPane label="Title candidates will appear here." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BlurbPackage {
  tagline: string;
  elevatorPitch: string;
  backCoverBlurb: string;
  amazonDescription: string;
  keywords: string[];
  categories: string[];
  targetReader: string;
}

export function BlurbTool() {
  const [form, setForm] = useState({ title: '', subtitle: '', premise: '', genre: '', audience: '', comparableTitles: '' });
  const { state, run } = useAiTask<BlurbPackage>('/api/author-empire/generate-blurb');
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title">
            <TextInput value={form.title} onChange={(e) => set('title')(e.target.value)} />
          </Field>
          <Field label="Subtitle">
            <TextInput value={form.subtitle} onChange={(e) => set('subtitle')(e.target.value)} />
          </Field>
        </div>
        <Field label="Premise">
          <TextArea rows={6} value={form.premise} onChange={(e) => set('premise')(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Genre">
            <TextInput value={form.genre} onChange={(e) => set('genre')(e.target.value)} />
          </Field>
          <Field label="Audience">
            <TextInput value={form.audience} onChange={(e) => set('audience')(e.target.value)} />
          </Field>
        </div>
        <Field label="Comparable titles" hint="Books a reader of yours already owns.">
          <TextInput
            value={form.comparableTitles}
            onChange={(e) => set('comparableTitles')(e.target.value)}
            placeholder="comma separated"
          />
        </Field>
        <RunButton
          label="Write the package"
          status={state.status}
          disabled={!form.premise.trim()}
          onClick={() =>
            run({ ...form, comparableTitles: form.comparableTitles.split(',').map((t) => t.trim()).filter(Boolean) })
          }
        />
        <TaskError state={state} />
      </div>

      <div className="space-y-3">
        {state.data ? (
          <>
            <ResultCard title="Tagline" actions={<CopyButton value={state.data.tagline} label="" />}>
              <p className="text-sm text-white font-display">{state.data.tagline}</p>
            </ResultCard>
            <ResultCard title="Back cover" actions={<CopyButton value={state.data.backCoverBlurb} label="" />}>
              <Prose text={state.data.backCoverBlurb} />
            </ResultCard>
            <ResultCard title="Amazon description" actions={<CopyButton value={state.data.amazonDescription} label="" />}>
              <Prose text={state.data.amazonDescription} />
            </ResultCard>
            <ResultCard title="Keywords and categories">
              <div className="flex flex-wrap gap-1.5">
                {[...(state.data.keywords ?? []), ...(state.data.categories ?? [])].map((item, index) => (
                  <span
                    key={index}
                    className="text-[10px] font-mono bg-[#18181B] border border-[#27272A] rounded px-2 py-1 text-[#A1A1AA]"
                  >
                    {item}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-[#71717A] mt-3 leading-relaxed">{state.data.targetReader}</p>
            </ResultCard>
          </>
        ) : (
          <EmptyPane label="The marketing package will appear here." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CoverTool() {
  const [form, setForm] = useState({ title: '', subtitle: '', author: '', genre: '', mood: '', styleHint: '', aspectRatio: '3:4' });
  const { state, run } = useAiTask<{ imageUrl: string; mimeType: string }>('/api/book/generate-cover');
  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title">
            <TextInput value={form.title} onChange={(e) => set('title')(e.target.value)} />
          </Field>
          <Field label="Author">
            <TextInput value={form.author} onChange={(e) => set('author')(e.target.value)} />
          </Field>
          <Field label="Genre">
            <TextInput value={form.genre} onChange={(e) => set('genre')(e.target.value)} placeholder="e.g. gothic mystery" />
          </Field>
          <Field label="Mood">
            <TextInput value={form.mood} onChange={(e) => set('mood')(e.target.value)} placeholder="e.g. cold, luminous" />
          </Field>
        </div>
        <Field label="Art direction" hint="The image is generated without text so you can set the typography yourself.">
          <TextArea rows={4} value={form.styleHint} onChange={(e) => set('styleHint')(e.target.value)} placeholder="e.g. single lighthouse silhouette, fog, cinematic backlight" />
        </Field>
        <Field label="Aspect ratio">
          <Select value={form.aspectRatio} onChange={(e) => set('aspectRatio')(e.target.value)}>
            <option value="3:4">3:4 — standard cover</option>
            <option value="1:1">1:1 — square</option>
            <option value="9:16">9:16 — tall</option>
          </Select>
        </Field>
        <RunButton label="Generate cover" status={state.status} disabled={!form.title.trim()} onClick={() => run(form)} />
        <TaskError state={state} />
      </div>

      <div>
        {state.data?.imageUrl ? (
          <ResultCard
            title="Generated cover"
            actions={
              <a
                href={state.data.imageUrl}
                download={`${form.title.replace(/[^a-z0-9]+/gi, '_') || 'cover'}.png`}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer"
              >
                Download
              </a>
            }
          >
            <img src={state.data.imageUrl} alt={`Cover concept for ${form.title}`} className="w-full rounded-lg" />
          </ResultCard>
        ) : (
          <EmptyPane label="The cover concept will appear here." icon />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CoverAudit {
  overallScore: number;
  genreSignalling: string;
  thumbnailLegibility: string;
  typography: string;
  colourAndContrast: string;
  focalClarity: string;
  strengths: string[];
  fixes: string[];
  combinedVerdict: string;
}

export function CoverAuditTool() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [meta, setMeta] = useState({ title: '', genre: '', audience: '' });
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, run } = useAiTask<CoverAudit>('/api/author-empire/analyze-cover');

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(chosen);
    });
  };

  const submit = () => {
    if (!file) return;
    const form = new FormData();
    form.append('image', file);
    form.append('title', meta.title);
    form.append('genre', meta.genre);
    form.append('audience', meta.audience);
    run(form);
  };

  const rows: [string, string][] = state.data
    ? [
        ['Genre signalling', state.data.genreSignalling],
        ['Thumbnail legibility', state.data.thumbnailLegibility],
        ['Typography', state.data.typography],
        ['Colour and contrast', state.data.colourAndContrast],
        ['Focal clarity', state.data.focalClarity],
      ]
    : [];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files?.[0]);
          }}
          className="border-2 border-dashed border-[#27272A] hover:border-[#D4AF37]/40 rounded-xl p-6 text-center cursor-pointer transition"
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => choose(e.target.files?.[0])}
          />
          {preview ? (
            <img src={preview} alt="Cover to audit" className="max-h-64 mx-auto rounded-lg" />
          ) : (
            <>
              <Upload className="w-6 h-6 text-[#D4AF37] mx-auto mb-2" />
              <p className="text-xs text-[#E4E4E7] font-medium">Drop a cover image</p>
              <p className="text-[10px] text-[#71717A] mt-1">PNG, JPEG or WebP</p>
            </>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Title">
            <TextInput value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
          </Field>
          <Field label="Genre">
            <TextInput value={meta.genre} onChange={(e) => setMeta({ ...meta, genre: e.target.value })} />
          </Field>
          <Field label="Audience">
            <TextInput value={meta.audience} onChange={(e) => setMeta({ ...meta, audience: e.target.value })} />
          </Field>
        </div>
        <RunButton label="Audit this cover" status={state.status} disabled={!file} onClick={submit} />
        <TaskError state={state} />
      </div>

      <div className="space-y-3">
        {state.data ? (
          <>
            <ResultCard title={`Overall — ${state.data.overallScore}/10`}>
              <Prose text={state.data.combinedVerdict} />
            </ResultCard>
            {rows.map(([label, value]) => (
              <ResultCard key={label} title={label}>
                <p className="text-[12px] leading-relaxed text-[#D1D1D6]">{value}</p>
              </ResultCard>
            ))}
            <ResultCard title="Fixes, in priority order">
              <ol className="space-y-1.5 list-decimal list-inside">
                {(state.data.fixes ?? []).map((fix, index) => (
                  <li key={index} className="text-[12px] text-[#D1D1D6] leading-relaxed">
                    {fix}
                  </li>
                ))}
              </ol>
            </ResultCard>
          </>
        ) : (
          <EmptyPane label="The design audit will appear here." icon />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ChapterOutlineItem {
  chapterNumber: number;
  title: string;
  focus: string;
  subsections: string[];
  emotionalArcOrKeyLesson: string;
  estimatedWordCount: number;
}

interface OutlineResult {
  suggestedBookTitle: string;
  suggestedSubTitle: string;
  chaptersSettingFocus: string;
  chapters: ChapterOutlineItem[];
}

export function OutlineTool() {
  const [form, setForm] = useState({
    title: '',
    genre: '',
    audience: '',
    tone: '',
    premise: '',
    authorPersona: '',
    targetChapterCount: 12,
    targetWordCount: 50000,
  });
  const outline = useAiTask<OutlineResult>('/api/book/generate-outline');
  const chapter = useAiTask<{ chapterText: string; actualWordCount: number }>('/api/book/generate-chapter');
  const [draftingNumber, setDraftingNumber] = useState<number | null>(null);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Working title">
            <TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Genre">
            <TextInput value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} />
          </Field>
          <Field label="Audience">
            <TextInput value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
          </Field>
          <Field label="Tone">
            <TextInput value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} />
          </Field>
        </div>
        <Field label="Premise">
          <TextArea rows={5} value={form.premise} onChange={(e) => setForm({ ...form, premise: e.target.value })} />
        </Field>
        <Field label="Author voice">
          <TextInput
            value={form.authorPersona}
            onChange={(e) => setForm({ ...form, authorPersona: e.target.value })}
            placeholder="e.g. wry, concrete, allergic to abstraction"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Chapters">
            <TextInput
              type="number"
              min={3}
              max={40}
              value={form.targetChapterCount}
              onChange={(e) => setForm({ ...form, targetChapterCount: Number(e.target.value) })}
            />
          </Field>
          <Field label="Target words">
            <TextInput
              type="number"
              min={5000}
              step={5000}
              value={form.targetWordCount}
              onChange={(e) => setForm({ ...form, targetWordCount: Number(e.target.value) })}
            />
          </Field>
        </div>
        <RunButton
          label="Build the blueprint"
          status={outline.state.status}
          disabled={!form.premise.trim()}
          onClick={() => outline.run(form)}
        />
        <TaskError state={outline.state} />
      </div>

      <div className="space-y-3">
        {outline.state.data ? (
          <>
            <ResultCard title="Proposed title">
              <p className="font-display font-bold text-white text-sm">{outline.state.data.suggestedBookTitle}</p>
              <p className="text-xs text-[#A1A1AA] mt-1">{outline.state.data.suggestedSubTitle}</p>
              <p className="text-[11px] text-[#71717A] mt-3 leading-relaxed">
                {outline.state.data.chaptersSettingFocus}
              </p>
            </ResultCard>

            {(outline.state.data.chapters ?? []).map((item) => (
              <div key={item.chapterNumber} className="bg-[#111114] border border-[#27272A] rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-sm font-semibold text-white">
                    <span className="text-[#D4AF37] font-mono text-xs mr-2">
                      {String(item.chapterNumber).padStart(2, '0')}
                    </span>
                    {item.title}
                  </h4>
                  <span className="text-[10px] font-mono text-[#71717A] shrink-0">
                    ~{item.estimatedWordCount.toLocaleString()}w
                  </span>
                </div>
                <p className="text-[11px] text-[#A1A1AA] mt-2 leading-relaxed">{item.focus}</p>
                {item.subsections?.length > 0 && (
                  <p className="text-[10px] text-[#71717A] mt-1.5">{item.subsections.join(' · ')}</p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDraftingNumber(item.chapterNumber);
                    chapter.run({
                      bookTitle: outline.state.data?.suggestedBookTitle || form.title,
                      genre: form.genre,
                      tone: form.tone,
                      authorPersona: form.authorPersona,
                      chapterOutline: item,
                      targetWordCount: item.estimatedWordCount,
                    });
                  }}
                  disabled={chapter.state.status === 'loading'}
                  className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] hover:underline cursor-pointer disabled:opacity-40"
                >
                  {chapter.state.status === 'loading' && draftingNumber === item.chapterNumber
                    ? 'Drafting…'
                    : 'Draft this chapter'}
                </button>

                {chapter.state.data && draftingNumber === item.chapterNumber && (
                  <div className="mt-3 pt-3 border-t border-[#27272A]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-mono text-[#71717A]">
                        {chapter.state.data.actualWordCount.toLocaleString()} words
                      </span>
                      <div className="flex gap-1.5">
                        <CopyButton value={chapter.state.data.chapterText} label="" />
                        <DownloadTextButton
                          value={chapter.state.data.chapterText}
                          fileName={`chapter_${item.chapterNumber}.txt`}
                        />
                      </div>
                    </div>
                    <div className="max-h-64 overflow-y-auto pr-1">
                      <Prose text={chapter.state.data.chapterText} />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <TaskError state={chapter.state} />
          </>
        ) : (
          <EmptyPane label="The chapter blueprint will appear here." />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmptyPane({ label, icon }: { label: string; icon?: boolean }) {
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center border border-dashed border-[#27272A] rounded-2xl p-10">
      {icon && <ImageIcon className="w-6 h-6 text-zinc-700 mb-2" />}
      <p className="text-[11px] text-[#52525B] leading-relaxed max-w-[220px]">{label}</p>
    </div>
  );
}
