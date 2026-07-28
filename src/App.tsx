import { useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import ConverterPanel from './components/ConverterPanel';
import ReaderEditorPanel from './components/ReaderEditorPanel';

export type ViewId = 'converter' | 'reader';

const ROUTES: Record<string, ViewId> = {
  '/': 'converter',
  '/converter': 'converter',
  '/reader': 'reader',
};

function viewFromPath(pathname: string): ViewId {
  return ROUTES[pathname] ?? 'converter';
}

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>(() =>
    viewFromPath(typeof window === 'undefined' ? '/' : window.location.pathname),
  );

  useEffect(() => {
    const onPopState = () => setActiveView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((view: ViewId) => {
    setActiveView(view);
    const nextPath = `/${view}`;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view }, '', nextPath);
    }
  }, []);

  return (
    <div className="flex h-screen w-screen bg-[#0A0A0B] overflow-hidden select-none text-[#E4E4E7]">
      <Sidebar activeView={activeView} setActiveView={navigate} />
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {activeView === 'reader' ? <ReaderEditorPanel /> : <ConverterPanel />}
      </div>
    </div>
  );
}
