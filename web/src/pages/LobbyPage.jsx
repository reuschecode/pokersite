import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { notify, canAskNotifications, askNotifications } from '../lib/notify';
import { Avatar } from '../components/table/Avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

function NicknameModal({ onClose }) {
  const [nick, setNick] = useState('');
  const [mode, setMode] = useState('guest'); // 'guest' | 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const { guestLogin, login, register } = useAuth();

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      if (mode === 'guest') await guestLogin(nick);
      else if (mode === 'login') await login(email, password);
      else await register(nick, email, password);
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Error');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <Card className="w-full max-w-sm shadow-2xl">
        <CardHeader>
          <CardTitle className="text-2xl text-center">♠ PokerSite</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            {['guest','login','register'].map(m => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={mode === m ? 'default' : 'secondary'}
                className="flex-1 text-xs"
                onClick={() => setMode(m)}
              >
                {m === 'guest' ? 'Invitado' : m === 'login' ? 'Iniciar sesión' : 'Registrarse'}
              </Button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-3">
            {mode !== 'login' && (
              <Input value={nick} onChange={e => setNick(e.target.value)} placeholder="Nickname" required minLength={2} maxLength={32} className="h-11" />
            )}
            {mode !== 'guest' && <>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required className="h-11" />
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Contraseña" required minLength={6} className="h-11" />
            </>}
            {err && <p className="text-red-400 text-sm">{err}</p>}
            <Button type="submit" className="w-full h-11 font-bold">
              {mode === 'guest' ? 'Entrar como invitado' : mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function TableCard({ table, onJoin }) {
  const seated = table.seated || 0;
  const full = seated >= table.max_seats;
  return (
    <div className="bg-gray-800 rounded-2xl p-5 border border-gray-700 hover:border-green-600 card-hover">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-bold text-white text-lg">{table.name}</h3>
          <span className="text-xs text-gray-400 uppercase tracking-wider">{table.game_type?.replace('_',' ')} · {table.chip_mode === 'real' ? '💵 Real' : '🎮 Play'}</span>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full font-semibold ${full ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
          {seated}/{table.max_seats}
        </span>
      </div>
      <div className="text-sm text-gray-300 mb-4">
        Ciegas: <span className="text-white font-mono">${table.small_blind}/${table.big_blind}</span>
        <span className="mx-2">·</span>
        Buy-in: <span className="text-white font-mono">${table.buy_in_min}–${table.buy_in_max}</span>
      </div>
      <button
        onClick={() => onJoin(table)}
        disabled={full}
        className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white font-bold py-2 rounded-xl transition-colors"
      >
        {full ? 'Mesa llena' : 'Unirse'}
      </button>
    </div>
  );
}

function MenuItem({ children, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 text-sm font-semibold border-b border-gray-800 last:border-0 active:bg-gray-800 ${danger ? 'text-red-400' : 'text-gray-200'}`}
    >
      {children}
    </button>
  );
}

export function LobbyPage() {
  const { player, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { connect, socket } = useSocket();
  const [tables, setTables] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [showAuth, setShowAuth] = useState(false);
  const [buyInModal, setBuyInModal] = useState(null);
  const [buyIn, setBuyIn] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now()); // reloj para cuentas regresivas
  const [joinCode, setJoinCode] = useState(''); // código de mesa privada
  const [showNotifBtn, setShowNotifBtn] = useState(() => canAskNotifications());
  const isMobile = useIsMobile();

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!player) { setShowAuth(true); return; }
    connect();
    fetchTables();
    fetchTournaments();
    const t = setInterval(() => { fetchTables(); fetchTournaments(); }, 8000);

    // Cuando mi torneo arranca, el server me avisa → entro a la mesa
    const s = socket?.current;
    const onStart = ({ tableId }) => {
      if (!tableId) return;
      toast.info('🏆 ¡Tu torneo está comenzando! Entrando a la mesa...');
      notify('🏆 ¡Tu torneo comienza!', 'Entrando a tu mesa...');
      navigate(`/table/${tableId}?buyIn=1500`);
    };
    s?.on?.('torneo_iniciado', onStart);

    return () => { clearInterval(t); s?.off?.('torneo_iniciado', onStart); };
  }, [player]);

  async function fetchTables() {
    try {
      const { data } = await api.get('/tables');
      setTables(data);
    } catch {}
  }

  async function fetchTournaments() {
    try {
      const { data } = await api.get('/tournaments');
      setTournaments(data);
    } catch {}
  }

  async function joinTournament(id) {
    try {
      const { data } = await api.post(`/tournaments/${id}/register`);
      if (data.tableId) {
        // Inscripción tardía / re-entry: directo a la mesa
        toast.success(data.reentry ? '🔄 ¡De vuelta al torneo!' : '🏆 ¡Dentro! Entrando a tu mesa...');
        navigate(`/table/${data.tableId}?buyIn=1500`);
        return;
      }
      toast.success('¡Inscrito al torneo! Te avisaremos cuando arranque.');
      fetchTournaments();
    } catch (e) {
      toast.error(e.response?.data?.error || 'No se pudo inscribir');
    }
  }

  // ── Home games: mesa privada con código ──
  async function createPrivateTable() {
    try {
      const { data } = await api.post('/tables/private', {});
      toast.success(`Mesa privada creada — código: ${data.inviteCode}`, { duration: 10000 });
      navigate(`/table/${data.id}?buyIn=${data.buyInMin}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'No se pudo crear la mesa');
    }
  }

  async function joinByCode() {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    try {
      const { data } = await api.get(`/tables/by-code/${code}`);
      navigate(`/table/${data.id}?buyIn=${data.buy_in_min}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Código no válido');
    }
  }

  // Entrar/volver a mi mesa de un torneo en curso
  async function enterTournament(id) {
    try {
      const { data } = await api.get(`/tournaments/${id}/my-table`);
      navigate(`/table/${data.tableId}?buyIn=1500`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'No se encontró tu mesa');
    }
  }

  function handleJoin(table) {
    if (!player) return setShowAuth(true);
    setBuyInModal(table);
    setBuyIn(String(table.buy_in_min));
  }

  async function confirmJoin() {
    navigate(`/table/${buyInModal.id}?buyIn=${buyIn}`);
    setBuyInModal(null);
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white lobby-bg">
      {showAuth && <NicknameModal onClose={() => setShowAuth(false)} />}

      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-gray-800 relative" style={{ zIndex: 40 }}>
        <h1 className="text-xl sm:text-2xl font-bold text-green-400">♠ PokerSite</h1>

        {player && (isMobile ? (
          /* ── Móvil: fichas + avatar + botón de menú ── */
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-400 font-mono">🎮 ${player.play_chips?.toLocaleString()}</span>
            <button onClick={() => navigate('/perfil')} className="active:brightness-125">
              <Avatar nickname={player.nickname} avatarConfig={player.avatar_config} size={34} />
            </button>
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-800 border border-gray-700 text-xl"
              aria-label="Menú"
            >
              {menuOpen ? '✕' : '☰'}
            </button>

            {/* Menú desplegable con opciones grandes */}
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-3 top-full mt-1 w-60 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 text-sm text-gray-400">
                    Hola, <span className="text-white font-bold">{player.nickname}</span>
                  </div>
                  {isAdmin && (
                    <MenuItem onClick={() => { setMenuOpen(false); navigate('/admin/bots'); }}>⚙️ Panel Admin</MenuItem>
                  )}
                  <MenuItem onClick={() => { setMenuOpen(false); navigate('/perfil'); }}>🎭 Mi perfil</MenuItem>
                  <MenuItem onClick={() => { setMenuOpen(false); navigate('/estadisticas'); }}>📈 Estadísticas</MenuItem>
                  <MenuItem onClick={() => { setMenuOpen(false); navigate('/historial'); }}>📜 Mis manos</MenuItem>
                  <MenuItem onClick={() => { setMenuOpen(false); logout(); }} danger>🚪 Salir</MenuItem>
                </div>
              </>
            )}
          </div>
        ) : (
          /* ── Escritorio: barra horizontal ── */
          <div className="flex items-center gap-4">
            {isAdmin && <button onClick={() => navigate('/admin/bots')} className="text-xs text-yellow-400 hover:text-yellow-300 font-bold">⚙️ Admin</button>}
            <button onClick={() => navigate('/estadisticas')} className="text-xs text-green-400 hover:text-green-300 font-bold">📈 Estadísticas</button>
            <button onClick={() => navigate('/historial')} className="text-xs text-sky-400 hover:text-sky-300 font-bold">📜 Mis manos</button>
            <button onClick={() => navigate('/perfil')} className="flex items-center gap-2 hover:brightness-125 transition" title="Editar mi perfil">
              <Avatar nickname={player.nickname} avatarConfig={player.avatar_config} size={30} />
              <span className="text-sm text-gray-300">{player.nickname}</span>
            </button>
            <span className="text-sm text-green-400 font-mono">🎮 ${player.play_chips?.toLocaleString()}</span>
            <button onClick={logout} className="text-xs text-gray-500 hover:text-gray-300">Salir</button>
          </div>
        ))}
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Torneos */}
        {tournaments.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold mb-4">🏆 Campeonatos</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {tournaments.map(t => {
                const mine = !!t.am_registered;
                const eliminated = mine && t.my_final_position !== null;
                const playing = mine && t.my_final_position === null;
                const full = t.registered >= t.max_players;
                const running = t.status === 'running';
                // Cuenta regresiva del inicio programado
                let countdown = null;
                if (!running && t.starts_at) {
                  const diff = new Date(t.starts_at).getTime() - nowTick;
                  if (diff > 0) {
                    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
                    countdown = h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
                  } else countdown = 'por comenzar...';
                }
                // Botón según mi estado
                let btn;
                if (running && playing) {
                  btn = <button onClick={() => enterTournament(t.id)} className="w-full bg-green-700 hover:bg-green-600 text-white font-bold py-2 rounded-xl transition-colors">▶ Entrar al torneo</button>;
                } else if (running && eliminated && t.late_reg_open) {
                  btn = <button onClick={() => joinTournament(t.id)} className="w-full bg-purple-700 hover:bg-purple-600 text-white font-bold py-2 rounded-xl transition-colors">🔄 Re-entrar (${t.buy_in})</button>;
                } else if (running && !mine && t.late_reg_open) {
                  btn = <button onClick={() => joinTournament(t.id)} className="w-full bg-yellow-700 hover:bg-yellow-600 text-white font-bold py-2 rounded-xl transition-colors">🕐 Inscripción tardía (${t.buy_in})</button>;
                } else if (running) {
                  btn = <button disabled className="w-full bg-gray-700 opacity-40 text-white font-bold py-2 rounded-xl">{eliminated ? `Eliminado (${t.my_final_position}º)` : 'En curso'}</button>;
                } else {
                  btn = (
                    <button
                      onClick={() => joinTournament(t.id)}
                      disabled={full || mine}
                      className="w-full bg-yellow-700 hover:bg-yellow-600 disabled:opacity-40 text-white font-bold py-2 rounded-xl transition-colors"
                    >
                      {mine ? 'Inscrito ✓' : full ? 'Completo' : 'Inscribirme'}
                    </button>
                  );
                }
                return (
                  <div key={t.id} className="bg-gray-800 rounded-2xl p-5 border border-yellow-800/40 card-hover">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-white text-lg">{t.name}</h3>
                      <span className={`text-xs px-2 py-1 rounded-full font-semibold ${running ? 'bg-green-900 text-green-300' : 'bg-sky-900 text-sky-300'}`}>
                        {running ? 'En curso' : `${t.registered}/${t.max_players}`}
                      </span>
                    </div>
                    <div className="text-sm text-gray-300 mb-1">
                      Buy-in: <span className="text-white font-mono">${t.buy_in}</span>
                      <span className="mx-2">·</span>
                      Bote: <span className="text-yellow-400 font-mono">${t.prize_pool}</span>
                    </div>
                    {countdown && (
                      <div className="text-sm text-yellow-300 font-semibold mb-3">🕐 Empieza en {countdown}</div>
                    )}
                    {running && t.late_reg_open && !playing && (
                      <div className="text-xs text-sky-300 mb-3">Inscripción tardía abierta</div>
                    )}
                    {!countdown && !(running && t.late_reg_open && !playing) && <div className="mb-3" />}
                    {btn}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Aviso de notificaciones (una sola vez) */}
        {showNotifBtn && (
          <div className="mb-6 flex items-center justify-between bg-sky-950/50 border border-sky-800/50 rounded-xl px-4 py-3">
            <span className="text-sm text-sky-200">🔔 Activa los avisos para saber cuando es tu turno o empieza tu torneo (aunque estés en otra pestaña)</span>
            <button
              onClick={async () => { await askNotifications(); setShowNotifBtn(false); }}
              className="shrink-0 ml-3 bg-sky-700 hover:bg-sky-600 text-white text-sm font-bold px-4 py-1.5 rounded-lg"
            >
              Activar
            </button>
          </div>
        )}

        {/* Home games: mesas privadas con código */}
        <div className="mb-8 bg-gray-800/70 border border-purple-800/40 rounded-2xl p-5">
          <h2 className="text-lg font-bold mb-1">🏠 Mesa privada (Home Game)</h2>
          <p className="text-sm text-gray-400 mb-4">Crea tu mesa y comparte el código con tus amigos — no aparece en el lobby.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={createPrivateTable}
              className="bg-purple-700 hover:bg-purple-600 text-white font-bold px-5 py-2 rounded-xl transition-colors"
            >
              + Crear mi mesa privada
            </button>
            <span className="text-gray-500 text-sm">o</span>
            <div className="flex gap-2">
              <input
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && joinByCode()}
                placeholder="CÓDIGO"
                maxLength={8}
                className="w-32 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-center font-mono tracking-widest uppercase"
              />
              <button
                onClick={joinByCode}
                className="bg-gray-700 hover:bg-gray-600 text-white font-bold px-4 py-2 rounded-xl transition-colors"
              >
                Unirme
              </button>
            </div>
          </div>
        </div>

        <h2 className="text-xl font-bold mb-6">Mesas disponibles</h2>
        {tables.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <div className="text-6xl mb-4">🂠</div>
            <p>No hay mesas disponibles.</p>
            <p className="text-sm mt-1">Pide a un admin que cree una mesa.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tables.map(t => <TableCard key={t.id} table={t} onJoin={handleJoin} />)}
          </div>
        )}
      </main>

      <Dialog open={!!buyInModal} onOpenChange={(open) => { if (!open) setBuyInModal(null); }}>
        <DialogContent className="w-[340px]">
          <DialogHeader>
            <DialogTitle>Unirse a {buyInModal?.name}</DialogTitle>
            <DialogDescription>
              Buy-in permitido: ${buyInModal?.buy_in_min}–${buyInModal?.buy_in_max}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="number"
            value={buyIn}
            onChange={e => setBuyIn(e.target.value)}
            min={buyInModal?.buy_in_min}
            max={buyInModal?.buy_in_max}
            className="h-11"
          />
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setBuyInModal(null)}>Cancelar</Button>
            <Button className="flex-1 font-bold" onClick={confirmJoin}>Entrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
