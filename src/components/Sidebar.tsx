import { BookOpen, RefreshCw } from 'lucide-react';
import type { ViewId } from '../App';

interface SidebarProps {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
}

const NAV_ITEMS: { id: ViewId; label: string; hint: string; icon: typeof BookOpen }[] = [
  { id: 'converter', label: 'File Converter', hint: 'PDF, ePub, Docx, RTF, TXT', icon: RefreshCw },
  { id: 'reader', label: 'Reader & Editor', hint: 'Read, edit & save book files', icon: BookOpen },
];

export default function Sidebar({ activeView, setActiveView }: SidebarProps) {
  return (
    <nav className="w-72 shrink-0 border-r border-[#27272A] bg-[#111114] h-screen flex flex-col select-none text-[#E4E4E7]">
      <div className="p-6 border-b border-[#27272A]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#D4AF37] rounded-lg flex items-center justify-center text-[#0A0A0B] font-extrabold shadow-md shadow-[#D4AF37]/10">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <h1 className="font-display font-black text-white text-sm leading-tight tracking-wider uppercase">
              BookForge
            </h1>
            <span className="text-[10px] font-mono text-[#D4AF37] tracking-widest uppercase">File Tools</span>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-6 space-y-2">
        <span className="text-[10px] font-bold font-display tracking-widest text-[#71717A] uppercase px-2">
          Tools
        </span>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <div key={item.id} className="px-2 mt-2">
              <button
                type="button"
                onClick={() => setActiveView(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full text-left p-3.5 rounded-xl border cursor-pointer transition-all flex items-center gap-3 ${
                  isActive
                    ? 'bg-[#D4AF37]/10 border-[#D4AF37] text-[#D4AF37] shadow-[0_0_15px_rgba(212,175,55,0.05)]'
                    : 'bg-[#18181B] border-[#27272A] text-[#A1A1AA] hover:text-[#E4E4E7] hover:border-[#3F3F46]'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isActive ? 'bg-[#D4AF37] text-black' : 'bg-[#27272A] text-[#D4AF37]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-white">{item.label}</span>
                  <p className="text-[10px] text-[#71717A] truncate mt-0.5">{item.hint}</p>
                </div>
              </button>
            </div>
          );
        })}
      </div>

      <div className="p-5 border-t border-[#27272A] bg-[#0E0E11] text-[11px] text-[#71717A] flex items-center justify-between">
        <span>BookForge v2.0</span>
        <span className="font-mono text-[10px] text-[#3F3F46]">EPUB 3.0</span>
      </div>
    </nav>
  );
}
