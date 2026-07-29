import React, { useCallback, useState } from 'react';
import { AlertCircle, Check, Copy, Download, Loader2, Sparkles } from 'lucide-react';

/** Shared request state for every AI tool in the studio. */
export type TaskStatus = 'idle' | 'loading' | 'done' | 'error';

export interface TaskState<T> {
  status: TaskStatus;
  data?: T;
  error?: string;
  /** Set when the server reports no AI provider is configured. */
  unavailable?: boolean;
}

export function useAiTask<T>(endpoint: string) {
  const [state, setState] = useState<TaskState<T>>({ status: 'idle' });

  const run = useCallback(
    async (body: unknown | FormData) => {
      setState({ status: 'loading' });
      try {
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        const response = await fetch(endpoint, {
          method: 'POST',
          ...(isForm ? {} : { headers: { 'Content-Type': 'application/json' } }),
          body: isForm ? (body as FormData) : JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setState({
            status: 'error',
            error: payload.error || `Request failed (HTTP ${response.status})`,
            unavailable: response.status === 503,
          });
          return null;
        }
        setState({ status: 'done', data: payload as T });
        return payload as T;
      } catch (error) {
        setState({ status: 'error', error: error instanceof Error ? error.message : 'Request failed' });
        return null;
      }
    },
    [endpoint],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { state, run, reset };
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider block mb-1.5">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10px] text-[#52525B] mt-1 block leading-relaxed">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full bg-[#0D0D10] border border-[#27272A] rounded-lg px-3 py-2 text-xs text-[#E4E4E7] placeholder-[#52525B] focus:outline-none focus:border-[#D4AF37]/60 transition';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputClass} />;
}

export function TextArea({ rows = 6, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} {...props} className={`${inputClass} resize-y leading-relaxed`} />;
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${inputClass} cursor-pointer`}>
      {children}
    </select>
  );
}

export function RunButton({
  label,
  status,
  disabled,
  onClick,
}: {
  label: string;
  status: TaskStatus;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || status === 'loading'}
      className="w-full flex items-center justify-center gap-2 py-3 bg-[#D4AF37] text-black hover:bg-[#b08e24] disabled:opacity-30 disabled:pointer-events-none font-bold text-[11px] uppercase tracking-wider rounded-xl transition cursor-pointer"
    >
      {status === 'loading' ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" /> Working…
        </>
      ) : (
        <>
          <Sparkles className="w-4 h-4" /> {label}
        </>
      )}
    </button>
  );
}

export function TaskError({ state }: { state: TaskState<unknown> }) {
  if (state.status !== 'error') return null;
  return (
    <div
      role="alert"
      className={`p-3 rounded-xl border flex items-start gap-2.5 ${
        state.unavailable
          ? 'bg-amber-950/20 border-amber-500/25 text-amber-300'
          : 'bg-red-950/20 border-red-500/25 text-red-300'
      }`}
    >
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="text-[11px] leading-relaxed min-w-0">
        <p className="break-words">{state.error}</p>
        {state.unavailable && (
          <p className="mt-1 text-amber-400/80">
            Set <code className="font-mono">GEMINI_API_KEY</code> in the deployment environment to enable the AI
            tools. Conversion, parsing and exports work without it.
          </p>
        )}
      </div>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => undefined);
      }}
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#D4AF37] bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-lg hover:bg-[#D4AF37]/20 transition cursor-pointer"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied' : label}
    </button>
  );
}

export function DownloadTextButton({ value, fileName }: { value: string; fileName: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }}
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300 bg-[#18181B] border border-[#27272A] rounded-lg hover:text-white transition cursor-pointer"
    >
      <Download className="w-3 h-3" /> .txt
    </button>
  );
}

export function ResultCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[#111114] border border-[#27272A] rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#27272A] bg-[#0D0D10]">
        <h3 className="text-[10px] uppercase font-mono font-bold text-[#71717A] tracking-wider">{title}</h3>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function Prose({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-[#D1D1D6] font-serif whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}
