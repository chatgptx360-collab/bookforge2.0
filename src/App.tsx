import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Menu } from 'lucide-react';
import Sidebar from './components/Sidebar';
import ConverterPanel from './components/ConverterPanel';
import ReaderEditorPanel from './components/ReaderEditorPanel';
import AudiobookPanel from './components/AudiobookPanel';
import TtsStudioPanel from './components/TtsStudioPanel';
import AuditPanel from './components/AuditPanel';

export type ViewId = 'converter' | 'reader' | 'audiobook' | 'speech' | 'check';

/**
 * Audiobook Studio is paused, not deleted.
 *
 * Nothing about it has been removed — the panel, its worker plumbing, its
 * autosave and its test suite are all still here and still type-checked. This
 * flag is the whole of the hiding: it drops the sidebar entry and the route,
 * so the view is unreachable and Vite leaves it out of the bundle. Set it to
 * false to bring the studio back, and un-skip tests/audiobook.browser.mjs at
 * the same time.
 *
 * Typed as boolean rather than left to infer `true`, so the disabled branches
 * do not read as dead code.
 */
export const AUDIOBOOK_PAUSED: boolean = true;

const ROUTES: Record<string, ViewId> = {
  '/': 'converter',
  '/converter': 'converter',
  '/reader': 'reader',
  ...(AUDIOBOOK_PAUSED ? {} : { '/audiobook': 'audiobook' as ViewId }),
  '/speech': 'speech',
  '/check': 'check',
};

function viewFromPath(pathname: string): ViewId {
  return ROUTES[pathname] ?? 'converter';
}

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>(() =>
    viewFromPath(typeof window === 'undefined' ? '/' : window.location.pathname),
  );
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    // Retired and paused views (the old translator and author studio, and
    // Audiobook Studio for now) still live in people's bookmarks; land them on
    // the converter with a matching URL rather than leaving a dead path in the
    // address bar.
    if (!(window.location.pathname in ROUTES)) {
      window.history.replaceState({ view: 'converter' }, '', '/converter');
    }
    const onPopState = () => setActiveView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((view: ViewId) => {
    setActiveView(view);
    setNavOpen(false);
    const nextPath = `/${view}`;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view }, '', nextPath);
    }
  }, []);

  return (
    <div className="flex h-dvh w-screen bg-[#0A0A0B] overflow-hidden select-none text-[#E4E4E7]">
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <Sidebar activeView={activeView} setActiveView={navigate} isOpen={navOpen} onClose={() => setNavOpen(false)} />

      <div className="flex-1 flex flex-col h-dvh overflow-hidden min-w-0">
        <div className="md:hidden h-12 shrink-0 flex items-center gap-3 px-3 border-b border-[#27272A] bg-[#111114]">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="p-2 -ml-1 rounded-lg text-[#A1A1AA] hover:text-white cursor-pointer"
            aria-label="Open navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 bg-[#D4AF37] rounded-md flex items-center justify-center text-[#0A0A0B] shrink-0">
              <BookOpen className="w-3.5 h-3.5" />
            </div>
            <span className="font-display font-black text-white text-xs tracking-wider uppercase truncate">
              BookForge
            </span>
          </div>
        </div>

        {activeView === 'reader' ? (
          <ReaderEditorPanel />
        ) : activeView === 'audiobook' && !AUDIOBOOK_PAUSED ? (
          <AudiobookPanel />
        ) : activeView === 'speech' ? (
          <TtsStudioPanel />
        ) : activeView === 'check' ? (
          <AuditPanel />
        ) : (
          <ConverterPanel />
        )}
      </div>
    </div>
  );
}
