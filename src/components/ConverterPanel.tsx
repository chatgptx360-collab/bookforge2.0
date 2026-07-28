import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileCheck,
  Upload,
  ArrowRight,
  RefreshCw,
  Check,
  Download,
  AlertCircle,
  Trash2,
  FileText,
  BadgeAlert,
  Archive,
} from 'lucide-react';
import type { TargetFormat } from '../types';

interface ConvertedFile {
  id: string;
  originalName: string;
  originalSize: number;
  originalFormat: string;
  targetFormat: string;
  blob: Blob;
  downloadUrl: string;
  finalName: string;
  timestamp: string;
}

interface FileProgress {
  name: string;
  status: 'pending' | 'converting' | 'done' | 'error';
  percent: number;
  error?: string;
}

const ACCEPTED_FORMATS = ['.docx', '.pdf', '.epub', '.txt', '.rtf'];
const TARGET_FORMATS: TargetFormat[] = ['docx', 'pdf', 'epub', 'txt', 'rtf'];

const FORMAT_LABELS: Record<string, string> = {
  docx: 'DOCX (Word Document)',
  pdf: 'PDF (Portable Document)',
  epub: 'ePub (eBook Format)',
  txt: 'TXT (Plain Text)',
  rtf: 'RTF (Rich Text Format)',
};

function getFormatLabel(format: string): string {
  const key = format.replace(/^\./, '').toLowerCase();
  return FORMAT_LABELS[key] ?? key.toUpperCase();
}

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx === -1 ? '' : fileName.slice(idx).toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Upload + convert a single file. Uses XHR (rather than fetch) so the upload
 * phase reports real byte progress for the per-file progress bar.
 */
function convertFile(
  file: File,
  targetFormat: string,
  onProgress: (percent: number) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('targetFormat', targetFormat);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/book/convert');
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        // Upload accounts for the first 60% of the bar; the server does the rest.
        onProgress(Math.round((event.loaded / event.total) * 60));
      }
    };
    xhr.upload.onload = () => onProgress(65);
    xhr.onprogress = () => onProgress(90);

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(xhr.response as Blob);
        return;
      }
      let message = `Failed to convert ${file.name} (HTTP ${xhr.status})`;
      try {
        const text = await (xhr.response as Blob).text();
        const parsed = JSON.parse(text);
        if (parsed?.error) message = parsed.error;
      } catch {
        /* response was not JSON — keep the generic message */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error(`Network error while converting ${file.name}`));
    xhr.onabort = () => reject(new Error(`Conversion of ${file.name} was aborted`));

    xhr.send(formData);
  });
}

export default function ConverterPanel() {
  const [files, setFiles] = useState<File[]>([]);
  const [targetFormat, setTargetFormat] = useState<TargetFormat>('docx');
  const [isDragOver, setIsDragOver] = useState(false);
  const [status, setStatus] = useState<'idle' | 'converting' | 'completed' | 'failed'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [convertedHistory, setConvertedHistory] = useState<ConvertedFile[]>([]);
  const [fileProgress, setFileProgress] = useState<FileProgress[]>([]);
  const [currentConvertIdx, setCurrentConvertIdx] = useState(-1);
  const [isZipping, setIsZipping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emptyInputRef = useRef<HTMLInputElement>(null);

  // Object URLs live for the whole session; release them when the panel unmounts.
  const objectUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const addFiles = useCallback(
    (newFiles: File[]) => {
      setErrorMsg(null);
      setStatus('idle');
      setFileProgress([]);

      const rejected: string[] = [];
      const valid: File[] = [];
      for (const f of newFiles) {
        const ext = extensionOf(f.name);
        if (!ACCEPTED_FORMATS.includes(ext)) {
          rejected.push(f.name);
          continue;
        }
        valid.push(f);
      }

      if (rejected.length > 0) {
        setErrorMsg(
          `Unsupported file${rejected.length > 1 ? 's' : ''}: ${rejected.join(', ')}. Upload .docx, .pdf, .epub, .txt or .rtf.`,
        );
      }

      if (valid.length === 0) return;

      setFiles((prev) => {
        const merged = [...prev];
        for (const f of valid) {
          if (!merged.some((existing) => existing.name === f.name && existing.size === f.size)) {
            merged.push(f);
          }
        }
        return merged;
      });

      // Default the target to something other than the source format.
      const sourceExt = extensionOf(valid[0].name);
      setTargetFormat((current) =>
        `.${current}` === sourceExt ? (sourceExt === '.docx' ? 'pdf' : 'docx') : current,
      );
    },
    [],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const clearFiles = () => {
    setFiles([]);
    setStatus('idle');
    setErrorMsg(null);
    setFileProgress([]);
  };

  const updateProgress = (index: number, patch: Partial<FileProgress>) =>
    setFileProgress((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  const handleConvert = async () => {
    if (files.length === 0) return;
    setStatus('converting');
    setErrorMsg(null);
    setFileProgress(files.map((f) => ({ name: f.name, status: 'pending', percent: 0 })));

    let failedCount = 0;
    let lastError: string | null = null;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setCurrentConvertIdx(i);
      updateProgress(i, { status: 'converting', percent: 5 });

      try {
        const blob = await convertFile(f, targetFormat, (percent) => updateProgress(i, { percent }));
        const downloadUrl = URL.createObjectURL(blob);
        objectUrlsRef.current.push(downloadUrl);

        const dotIdx = f.name.lastIndexOf('.');
        const baseName = dotIdx === -1 ? f.name : f.name.slice(0, dotIdx);
        const finalName = `${baseName}.${targetFormat}`;

        setConvertedHistory((prev) => [
          {
            id: `conv_${Date.now()}_${i}`,
            originalName: f.name,
            originalSize: f.size,
            originalFormat: extensionOf(f.name).replace('.', '') || 'unknown',
            targetFormat,
            blob,
            downloadUrl,
            finalName,
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
          },
          ...prev,
        ]);
        updateProgress(i, { status: 'done', percent: 100 });

        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = finalName;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (err) {
        const message = err instanceof Error ? err.message : `Something went wrong converting ${f.name}.`;
        failedCount++;
        lastError = message;
        updateProgress(i, { status: 'error', percent: 100, error: message });
      }
    }

    setCurrentConvertIdx(-1);
    setErrorMsg(lastError);
    setStatus(failedCount === files.length ? 'failed' : 'completed');
  };

  const handleDownloadAll = async () => {
    if (convertedHistory.length === 0) return;
    setIsZipping(true);
    try {
      // JSZip is only needed for batch downloads — keep it out of the entry chunk.
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const usedNames = new Set<string>();
      for (const item of convertedHistory) {
        let name = item.finalName;
        let counter = 2;
        while (usedNames.has(name)) {
          const dotIdx = item.finalName.lastIndexOf('.');
          name = `${item.finalName.slice(0, dotIdx)}_${counter}${item.finalName.slice(dotIdx)}`;
          counter++;
        }
        usedNames.add(name);
        zip.file(name, item.blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bookforge_converted_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } finally {
      setIsZipping(false);
    }
  };

  const deleteHistoryItem = (id: string) =>
    setConvertedHistory((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.downloadUrl);
        objectUrlsRef.current = objectUrlsRef.current.filter((url) => url !== target.downloadUrl);
      }
      return prev.filter((item) => item.id !== id);
    });

  const overallPercent =
    fileProgress.length === 0
      ? 0
      : Math.round(fileProgress.reduce((sum, p) => sum + p.percent, 0) / fileProgress.length);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-10 bg-[#0A0A0B] space-y-8 select-none">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Utility Workspace
        </div>
        <h1 className="text-3xl font-display font-bold text-white tracking-tight mt-1">
          Universal Book &amp; File Converter
        </h1>
        <p className="text-sm text-[#71717A] max-w-xl mt-1 leading-relaxed">
          Upload any text, book, or manuscript document and turn it into clean DOCX, PDF, EPUB 3.0, TXT, or RTF
          with correct formatting.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <section className="lg:col-span-7 bg-[#111114] border border-[#27272A] rounded-2xl p-6 shadow-xl space-y-6">
          <h2 className="text-sm font-semibold tracking-wider text-white uppercase flex items-center gap-2">
            <Upload className="w-4 h-4 text-[#D4AF37]" /> Upload and Parameterize
          </h2>

          {files.length === 0 ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => emptyInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 transition h-64 flex flex-col items-center justify-center text-center cursor-pointer ${
                isDragOver
                  ? 'border-[#D4AF37] bg-[#D4AF37]/5'
                  : 'border-[#27272A] hover:border-[#D4AF37]/40 hover:bg-[#18181B]'
              }`}
            >
              <input
                type="file"
                ref={emptyInputRef}
                onChange={handleFileChange}
                accept={ACCEPTED_FORMATS.join(',')}
                multiple
                className="hidden"
              />
              <div className="w-12 h-12 bg-[#1E1E22] border border-[#27272A] rounded-xl flex items-center justify-center text-[#D4AF37] mb-4">
                <Upload className="w-6 h-6" />
              </div>
              <h3 className="text-[#E4E4E7] text-sm font-semibold">Drag &amp; drop your files here</h3>
              <p className="text-[#71717A] text-xs mt-1.5 max-w-xs leading-relaxed">
                Supports <span className="text-zinc-300 font-medium">DOCX, PDF, ePub, RTF, or TXT</span> — select
                multiple files at once.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {files.map((f, idx) => {
                  const progress = fileProgress[idx];
                  return (
                    <motion.div
                      key={`${f.name}-${f.size}-${idx}`}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="border border-[#27272A] bg-[#18181B] rounded-xl p-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-9 h-9 border rounded-lg flex items-center justify-center flex-shrink-0 font-mono text-[10px] font-bold uppercase ${
                              progress?.status === 'done'
                                ? 'bg-emerald-950/30 text-emerald-400 border-emerald-500/20'
                                : progress?.status === 'error'
                                  ? 'bg-red-950/30 text-red-400 border-red-500/20'
                                  : 'bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/20'
                            }`}
                          >
                            {progress?.status === 'done' ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : progress?.status === 'error' ? (
                              <AlertCircle className="w-3.5 h-3.5" />
                            ) : progress?.status === 'converting' ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              extensionOf(f.name).replace('.', '').slice(0, 4)
                            )}
                          </div>
                          <div className="min-w-0">
                            <h4 className="text-xs font-medium text-white truncate leading-snug">{f.name}</h4>
                            <span className="text-[10px] text-zinc-500 font-mono">{formatBytes(f.size)}</span>
                          </div>
                        </div>
                        {status !== 'converting' && (
                          <button
                            type="button"
                            onClick={() => removeFile(idx)}
                            className="p-1.5 hover:bg-red-950/40 text-zinc-500 hover:text-red-400 border border-transparent hover:border-red-500/20 rounded-lg transition-colors cursor-pointer flex-shrink-0"
                            title="Remove file"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {progress && progress.status !== 'pending' && (
                        <div className="mt-2 h-1 bg-[#27272A] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-200 ${
                              progress.status === 'error'
                                ? 'bg-red-500'
                                : progress.status === 'done'
                                  ? 'bg-emerald-500'
                                  : 'bg-[#D4AF37]'
                            }`}
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                      )}
                      {progress?.status === 'error' && progress.error && (
                        <p className="mt-1.5 text-[10px] text-red-400 font-mono truncate">{progress.error}</p>
                      )}
                    </motion.div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={status === 'converting'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-lg hover:bg-[#D4AF37]/10 transition cursor-pointer disabled:opacity-30"
                >
                  <Upload className="w-3 h-3" /> Add More
                </button>
                <button
                  type="button"
                  onClick={clearFiles}
                  disabled={status === 'converting'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-red-400 bg-zinc-800/50 border border-zinc-700 rounded-lg hover:bg-red-950/30 hover:border-red-500/20 transition cursor-pointer disabled:opacity-30"
                >
                  <Trash2 className="w-3 h-3" /> Clear All
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept={ACCEPTED_FORMATS.join(',')}
                  multiple
                  className="hidden"
                />
              </div>
            </div>
          )}

          {files.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 pt-4 border-t border-[#27272A]/40 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-11 gap-4 items-center">
                <div className="md:col-span-5 bg-[#0D0D10] border border-[#27272A] rounded-xl p-3">
                  <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block">
                    Detected Source
                  </span>
                  <span className="text-xs text-white font-medium mt-1 inline-block">
                    {files.length === 1
                      ? getFormatLabel(extensionOf(files[0].name))
                      : `${files.length} files selected`}
                  </span>
                </div>
                <div className="flex justify-center md:col-span-1 py-1">
                  <ArrowRight className="w-4 h-4 text-[#D4AF37]" />
                </div>
                <div className="md:col-span-5 bg-[#0D0D10] border border-[#27272A] rounded-xl p-3">
                  <label
                    htmlFor="target-format"
                    className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block"
                  >
                    Choose Target Format
                  </label>
                  <select
                    id="target-format"
                    value={targetFormat}
                    onChange={(e) => setTargetFormat(e.target.value as TargetFormat)}
                    disabled={status === 'converting'}
                    className="w-full text-xs bg-[#18181B] border border-[#27272A] rounded-lg p-2 font-medium text-[#E4E4E7] focus:outline-none focus:ring-1 focus:ring-[#D4AF37] custom-select mt-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {TARGET_FORMATS.map((fmt) => {
                      const isSame = files.length === 1 && extensionOf(files[0].name) === `.${fmt}`;
                      return (
                        <option key={fmt} value={fmt} disabled={isSame}>
                          {getFormatLabel(fmt)}
                          {isSame ? ' (Current)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <AnimatePresence mode="wait">
                {status === 'converting' && (
                  <motion.div
                    key="converting"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-2"
                  >
                    <div className="p-3.5 bg-[#D4AF37]/5 border border-[#D4AF37]/20 rounded-xl flex items-center gap-3">
                      <RefreshCw className="w-4 h-4 text-[#D4AF37] animate-spin" />
                      <span className="text-xs text-zinc-300 font-mono">
                        Converting {currentConvertIdx + 1} of {files.length} to {targetFormat.toUpperCase()}…
                      </span>
                    </div>
                    <div className="h-1.5 bg-[#27272A] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#D4AF37] rounded-full transition-all duration-300"
                        style={{ width: `${overallPercent}%` }}
                      />
                    </div>
                  </motion.div>
                )}
                {status === 'completed' && (
                  <motion.div
                    key="completed"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="p-3.5 bg-emerald-950/20 border border-emerald-500/20 rounded-xl flex items-center gap-3"
                  >
                    <Check className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs text-emerald-400 font-mono">
                      {fileProgress.filter((p) => p.status === 'done').length} file
                      {fileProgress.filter((p) => p.status === 'done').length !== 1 ? 's' : ''} converted. Downloads
                      started.
                    </span>
                  </motion.div>
                )}
                {status === 'failed' && errorMsg && (
                  <motion.div
                    key="failed"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="p-3.5 bg-red-950/20 border border-red-500/20 rounded-xl flex items-center gap-3"
                  >
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <span className="text-xs text-red-400 font-mono truncate">{errorMsg}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleConvert}
                  disabled={status === 'converting' || files.length === 0}
                  className="w-full flex items-center justify-center gap-2.5 py-4 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-xs uppercase tracking-wider rounded-xl transition shadow-lg shadow-[#D4AF37]/10 cursor-pointer"
                >
                  {status === 'converting' ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Converting {currentConvertIdx + 1} /{' '}
                      {files.length}…
                    </>
                  ) : (
                    <>
                      <FileCheck className="w-4 h-4" />{' '}
                      {files.length > 1 ? `Convert & Download All (${files.length})` : 'Convert & Download'}
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          )}

          {errorMsg && files.length === 0 && (
            <div className="p-3.5 bg-red-950/20 border border-red-500/20 rounded-xl flex items-center gap-3">
              <BadgeAlert className="w-4 h-4 text-red-400" />
              <span className="text-xs text-red-400 font-mono">{errorMsg}</span>
            </div>
          )}
        </section>

        <aside className="lg:col-span-5 space-y-4">
          <div className="bg-[#111114] border border-[#27272A] rounded-2xl p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-bold uppercase text-[#71717A] tracking-wider">
                Converted Downloads
              </h3>
              {convertedHistory.length > 1 && (
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  disabled={isZipping}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer disabled:opacity-40"
                >
                  <Archive className="w-3 h-3" /> {isZipping ? 'Zipping…' : 'Download All (ZIP)'}
                </button>
              )}
            </div>
            {convertedHistory.length === 0 ? (
              <div className="p-12 text-center bg-[#111114]/50 border border-dashed border-[#27272A] rounded-xl">
                <FileText className="w-6 h-6 text-zinc-600 mx-auto mb-2" />
                <p className="text-[#71717A] text-[11px] leading-relaxed">
                  No files converted in this session. Completed downloads will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                <AnimatePresence>
                  {convertedHistory.map((item) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="p-3.5 bg-[#18181B] border border-[#27272A] rounded-xl flex items-center justify-between"
                    >
                      <div className="min-w-0 pr-3.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono uppercase bg-[#27272A] text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700">
                            {item.targetFormat}
                          </span>
                          <span className="text-[10px] text-zinc-500 font-mono">{item.timestamp}</span>
                        </div>
                        <h4 className="text-xs font-medium text-[#E4E4E7] truncate mt-1.5 leading-snug">
                          {item.finalName}
                        </h4>
                        <span className="text-[10px] text-[#71717A] font-mono block mt-0.5">
                          From {item.originalFormat.toUpperCase()} ({formatBytes(item.originalSize)}) →{' '}
                          {formatBytes(item.blob.size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <a
                          href={item.downloadUrl}
                          download={item.finalName}
                          className="p-2 bg-[#D4AF37]/10 hover:bg-[#D4AF37] text-[#D4AF37] hover:text-black hover:shadow-lg border border-[#D4AF37]/20 hover:border-transparent rounded-lg transition-colors cursor-pointer block"
                          title="Re-download converted file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteHistoryItem(item.id)}
                          className="p-2 hover:bg-zinc-800 text-zinc-500 hover:text-white rounded-lg transition-colors cursor-pointer"
                          title="Delete from list"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
