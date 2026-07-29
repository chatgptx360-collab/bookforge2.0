import { useEffect, useState } from 'react';
import { Image, Languages, ListTree, Megaphone, ScanSearch, Sparkles, Wand2 } from 'lucide-react';
import {
  BlurbTool,
  CoverAuditTool,
  CoverTool,
  EnhanceTool,
  OutlineTool,
  TitlesTool,
  TranslateTool,
} from './studio/tools';

type ToolId = 'translate' | 'enhance' | 'outline' | 'titles' | 'blurb' | 'cover' | 'audit';

const TOOLS: { id: ToolId; label: string; blurb: string; icon: typeof Wand2 }[] = [
  { id: 'translate', label: 'Translate', blurb: 'Move a passage into another language, keeping its voice', icon: Languages },
  { id: 'enhance', label: 'Line edit', blurb: 'Tighten prose without losing your meaning', icon: Wand2 },
  { id: 'outline', label: 'Blueprint', blurb: 'Chapter-by-chapter plan, then draft any chapter', icon: ListTree },
  { id: 'titles', label: 'Titles', blurb: 'Title candidates with the angle behind each one', icon: Sparkles },
  { id: 'blurb', label: 'Marketing', blurb: 'Tagline, back cover, store description, keywords', icon: Megaphone },
  { id: 'cover', label: 'Cover art', blurb: 'Generate a cover concept with space for typography', icon: Image },
  { id: 'audit', label: 'Cover audit', blurb: 'Score an existing cover against its category', icon: ScanSearch },
];

export default function StudioPanel() {
  const [activeTool, setActiveTool] = useState<ToolId>('translate');
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((payload) => setAiStatus(String(payload.ai ?? 'unknown')))
      .catch(() => setAiStatus(null));
  }, []);

  const current = TOOLS.find((tool) => tool.id === activeTool) ?? TOOLS[0];

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 bg-[#0A0A0B] space-y-6 select-none">
      <header className="border-b border-[#27272A]/40 pb-6">
        <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-[#D4AF37] uppercase">
          <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse" />
          Author Studio
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-white tracking-tight mt-1">
          Writing &amp; Publishing Tools
        </h1>
        <p className="text-sm text-[#71717A] max-w-xl mt-1 leading-relaxed">
          Translation, line editing, chapter blueprints, titles, marketing copy and cover work — everything the
          server can do, in one place.
        </p>

        {aiStatus === 'disabled' && (
          <div className="mt-4 p-3 rounded-xl bg-amber-950/20 border border-amber-500/25 text-amber-300 text-[11px] leading-relaxed max-w-2xl">
            No AI provider is configured on this deployment, so the tools below will return an error until{' '}
            <code className="font-mono">GEMINI_API_KEY</code> (or <code className="font-mono">OPENROUTER_API_KEY</code>)
            is set. File conversion and the reader work regardless.
          </div>
        )}
      </header>

      <nav className="flex gap-2 overflow-x-auto no-scrollbar pb-1" aria-label="Studio tools">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isActive = tool.id === activeTool;
          return (
            <button
              key={tool.id}
              type="button"
              onClick={() => setActiveTool(tool.id)}
              aria-current={isActive ? 'true' : undefined}
              className={`shrink-0 flex items-center gap-2 px-3.5 py-2.5 rounded-xl border transition cursor-pointer ${
                isActive
                  ? 'bg-[#D4AF37]/10 border-[#D4AF37] text-[#D4AF37]'
                  : 'bg-[#111114] border-[#27272A] text-[#A1A1AA] hover:text-[#E4E4E7] hover:border-[#3F3F46]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="text-xs font-semibold whitespace-nowrap">{tool.label}</span>
            </button>
          );
        })}
      </nav>

      <p className="text-[11px] text-[#71717A] -mt-3">{current.blurb}.</p>

      <section>
        {activeTool === 'translate' && <TranslateTool />}
        {activeTool === 'enhance' && <EnhanceTool />}
        {activeTool === 'outline' && <OutlineTool />}
        {activeTool === 'titles' && <TitlesTool />}
        {activeTool === 'blurb' && <BlurbTool />}
        {activeTool === 'cover' && <CoverTool />}
        {activeTool === 'audit' && <CoverAuditTool />}
      </section>
    </div>
  );
}
