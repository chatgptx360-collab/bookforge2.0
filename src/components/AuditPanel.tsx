import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, ShieldCheck, Upload, Wrench } from 'lucide-react';
import { readJson } from '../utils/speech';
import { downloadBlob, safeFileName } from '../utils/audio';

const ACCEPTED = ['.docx', '.pdf', '.epub', '.txt', '.rtf'];

type Category = 'duplication' | 'repetitive-dialogue' | 'formulaic' | 'thin-content' | 'ai-tells';

interface Finding {
  category: Category;
  summary: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  examples: string[];
  fixable: boolean;
}

interface Report {
  findings: Finding[];
  stats: { words: number; chapters: number; vocabularyRatio: number; duplicateParagraphs: number };
  fixableCount: number;
}

const CATEGORY_LABEL: Record<Category, string> = {
  duplication: 'Duplication',
  'repetitive-dialogue': 'Repetitive dialogue',
  formulaic: 'Formulaic writing',
  'thin-content': 'Thin content',
  'ai-tells': 'Unedited-draft phrasing',
};

const SEVERITY_STYLE: Record<Finding['severity'], string> = {
  high: 'text-red-300 border-red-500/30 bg-red-950/20',
  medium: 'text-amber-300 border-amber-500/30 bg-amber-950/20',
  low: 'text-sky-300 border-sky-500/30 bg-sky-950/20',
};

export default function AuditPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [fileName, setFileName] = useState('');
  const [fixedText, setFixedText] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<File | null>(null);

  const audit = async (file: File) => {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED.includes(extension)) {
      setError(`Unsupported file: ${extension}. Upload .docx, .pdf, .epub, .txt or .rtf.`);
      return;
    }
    setBusy('Reading the manuscript…');
    setError(null);
    setFixedText(null);
    setChanges([]);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/book/audit', { method: 'POST', body: form });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(String(payload.error ?? 'The check failed.'));
      setReport(payload as unknown as Report);
      setFileName(file.name);
      sourceRef.current = file;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check failed.');
    } finally {
      setBusy(null);
    }
  };

  const fix = async () => {
    if (!sourceRef.current) return;
    setBusy('Removing the repetition…');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', sourceRef.current);
      const response = await fetch('/api/book/fix', { method: 'POST', body: form });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(String(payload.error ?? 'The fix failed.'));
      setFixedText(String(payload.text));
      setChanges((payload.changes as string[]) ?? []);
      setReport(payload.after as unknown as Report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The fix failed.');
    } finally {
      setBusy(null);
    }
  };

  const fixable = report?.findings.filter((f) => f.fixable) ?? [];
  const manual = report?.findings.filter((f) => !f.fixable) ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 bg-[#0A0A0B] space-y-6">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Manuscript Check
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
          Find What a Store Would Reject
        </h1>
        <p className="text-sm text-[#71717A] max-w-2xl mt-1 leading-relaxed">
          Checks for the things publishing platforms flag: duplication, repeated dialogue, formulaic sentences and
          thin chapters. Rule-based and offline — the same manuscript always gives the same answer.
        </p>
      </header>

      {error && (
        <div role="alert" className="p-3 rounded-xl bg-red-950/20 border border-red-500/25 text-red-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-relaxed">{error}</span>
        </div>
      )}
      {busy && (
        <div className="p-3 rounded-xl bg-[#D4AF37]/8 border border-[#D4AF37]/25 text-[#D4AF37] flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[11px]">{busy}</span>
        </div>
      )}

      {!report ? (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void audit(file);
          }}
          className="border-2 border-dashed border-[#27272A] hover:border-[#D4AF37]/40 rounded-2xl p-14 text-center cursor-pointer transition"
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void audit(file);
              e.target.value = '';
            }}
          />
          <Upload className="w-8 h-8 text-[#D4AF37] mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-[#E4E4E7]">Drop a manuscript to check</h3>
          <p className="text-[11px] text-[#71717A] mt-1.5">DOCX, PDF, EPUB, RTF or TXT</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 justify-between bg-[#111114] border border-[#27272A] rounded-2xl p-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">{fileName}</p>
              <p className="text-[10px] font-mono text-[#71717A] mt-0.5">
                {report.stats.words.toLocaleString()} words · {report.stats.chapters} chapters ·{' '}
                {(report.stats.vocabularyRatio * 100).toFixed(1)}% distinct words
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setReport(null);
                setFixedText(null);
                sourceRef.current = null;
              }}
              className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white cursor-pointer"
            >
              Check another
            </button>
          </div>

          {report.findings.length === 0 && (
            <div className="p-4 rounded-2xl bg-emerald-950/20 border border-emerald-500/25 text-emerald-300 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="text-[11px] leading-relaxed">
                Nothing flagged. This does not promise a store will accept it — judgment about the writing is beyond
                what any rule can measure — but the mechanical faults that get books rejected are absent.
              </span>
            </div>
          )}

          {fixable.length > 0 && (
            <div className="bg-[#111114] border border-[#D4AF37]/25 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-[10px] uppercase font-mono font-bold text-[#D4AF37] tracking-wider flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" /> Fixable automatically
                </h3>
                <button
                  type="button"
                  onClick={fix}
                  disabled={Boolean(busy)}
                  className="px-4 py-2 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-40 font-bold text-[11px] uppercase tracking-wider rounded-xl cursor-pointer"
                >
                  Fix errors
                </button>
              </div>
              <p className="text-[10px] text-[#71717A] leading-relaxed">
                Only deletes text that repeats or that the EPUB already provides. No sentence is rewritten, so what
                comes out is a subset of what went in.
              </p>
              {fixable.map((finding, index) => (
                <Row key={index} finding={finding} />
              ))}
            </div>
          )}

          {manual.length > 0 && (
            <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-4 space-y-3">
              <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Needs your judgment
              </h3>
              <p className="text-[10px] text-[#71717A] leading-relaxed">
                No button can fix these without rewriting your book, so they are counted and located instead.
              </p>
              {manual.map((finding, index) => (
                <Row key={index} finding={finding} />
              ))}
            </div>
          )}

          {fixedText !== null && (
            <div className="bg-[#111114] border border-emerald-500/25 rounded-2xl p-4 space-y-2">
              <h3 className="text-[10px] uppercase font-mono font-bold text-emerald-300 tracking-wider">
                Fixed — {changes.length === 0 ? 'nothing needed removing' : 'what changed'}
              </h3>
              {changes.map((change) => (
                <p key={change} className="text-[11px] text-[#A1A1AA]">
                  · {change}
                </p>
              ))}
              <button
                type="button"
                onClick={() =>
                  downloadBlob(
                    new Blob([fixedText], { type: 'text/plain;charset=utf-8' }),
                    `${safeFileName(fileName.replace(/\.[^.]+$/, ''), 'manuscript')}_fixed.txt`,
                  )
                }
                className="flex items-center gap-1.5 px-3 py-2 mt-1 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg cursor-pointer"
              >
                <Download className="w-3 h-3" /> Download cleaned text
              </button>
              <p className="text-[10px] text-[#52525B] leading-relaxed">
                Convert this file to EPUB to get a book without the duplication.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ finding }: { finding: Finding }) {
  return (
    <div className="p-3 rounded-xl bg-[#0D0D10] border border-[#27272A]/60 space-y-1.5">
      <div className="flex items-start gap-2 flex-wrap">
        <span
          className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${SEVERITY_STYLE[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#71717A] shrink-0">
          {CATEGORY_LABEL[finding.category]}
        </span>
      </div>
      <p className="text-[11px] text-[#E4E4E7] leading-relaxed">{finding.summary}</p>
      {finding.examples.length > 0 && (
        <ul className="space-y-0.5 pt-0.5">
          {finding.examples.map((example) => (
            <li key={example} className="text-[10px] font-mono text-[#71717A] break-words">
              {example}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
