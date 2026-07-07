import { useNavigate, useLocation } from 'react-router-dom';

const SECTIONS = [
  {
    title: 'Resumen',
    items: [
      { path: '/admin', label: 'Dashboard', icon: '📊' },
    ],
  },
  {
    title: 'Gestión',
    items: [
      { path: '/admin/bots', label: 'Bots', icon: '🤖' },
      { path: '/admin/torneos', label: 'Torneos', icon: '🏆' },
    ],
  },
  {
    title: 'Análisis',
    items: [
      { path: '/admin/precision', label: 'Precisión testers', icon: '🎯' },
    ],
  },
];

// Sidebar lateral del panel admin (estilo dashboard). Las páginas admin la usan
// como contenedor: <AdminNav>…contenido…</AdminNav>
export function AdminNav({ children }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const allItems = SECTIONS.flatMap(s => s.items);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-gray-950 text-white">
      {/* Móvil: barra superior con pestañas deslizables */}
      <div className="md:hidden sticky top-0 z-30 bg-black/80 backdrop-blur-sm border-b border-gray-800">
        <div className="flex items-center justify-between px-3 pt-2">
          <span className="font-black text-green-400">♠ Panel Admin</span>
          <button onClick={() => navigate('/')} className="text-xs text-gray-400 hover:text-white">← Lobby</button>
        </div>
        <nav className="flex gap-1 px-2 py-2 overflow-x-auto">
          {allItems.map(it => {
            const active = pathname === it.path;
            return (
              <button
                key={it.path}
                onClick={() => navigate(it.path)}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  active ? 'bg-green-900/60 text-green-300' : 'bg-gray-800/70 text-gray-400'
                }`}
              >
                <span>{it.icon}</span> {it.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Escritorio: sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-gray-800 bg-black/40 flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="font-black text-lg text-green-400">♠ PokerSite</div>
          <div className="text-[10px] uppercase tracking-widest text-yellow-500 font-bold">Panel Admin</div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-4 overflow-y-auto">
          {SECTIONS.map(sec => (
            <div key={sec.title}>
              <div className="px-2 mb-1 text-[10px] uppercase tracking-widest text-gray-600 font-bold">{sec.title}</div>
              {sec.items.map(it => {
                const active = pathname === it.path;
                return (
                  <button
                    key={it.path}
                    onClick={() => navigate(it.path)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                      active
                        ? 'bg-green-900/40 text-green-300 font-bold border-l-2 border-green-500'
                        : 'text-gray-400 hover:bg-gray-800/60 hover:text-white'
                    }`}
                  >
                    <span>{it.icon}</span> {it.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="px-2 py-3 border-t border-gray-800">
          <button
            onClick={() => navigate('/')}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-800/60 hover:text-white"
          >
            ← Volver al lobby
          </button>
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
