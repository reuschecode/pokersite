import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import api from '../../services/api';
import { AdminNav } from './AdminNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LEVELS = [5, 6, 7, 8, 9, 10];

// Validación del formulario de crear torneo
const torneoSchema = z.object({
  name: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres').max(64, 'Máximo 64 caracteres'),
  maxPlayers: z.coerce.number().int('Debe ser un número entero')
    .min(2, 'Mínimo 2 jugadores').max(30, 'Máximo 30 jugadores'),
  buyIn: z.coerce.number().min(0, 'El buy-in no puede ser negativo').max(100000, 'Buy-in demasiado alto'),
  bounty: z.coerce.number().min(0).max(100000).optional(),
  addedPrize: z.coerce.number().min(0).max(1000000).optional(),
  speed: z.enum(['normal', 'turbo', 'hyper', 'deep']),
});

// Presets de velocidad (niveles de ciegas). "normal" usa el schedule del servidor.
const SPEEDS = {
  normal: { label: 'Normal (3 min)', schedule: null },
  turbo: {
    label: 'Turbo (30s)',
    schedule: [
      { smallBlind: 20, bigBlind: 40, minutes: 0.5 },
      { smallBlind: 50, bigBlind: 100, minutes: 0.5 },
      { smallBlind: 150, bigBlind: 300, minutes: 0.5, ante: 30 },
      { smallBlind: 400, bigBlind: 800, minutes: 0.5, ante: 80 },
      { smallBlind: 1000, bigBlind: 2000, minutes: 99, ante: 200 },
    ],
  },
  hyper: {
    label: 'Hyper (15s)',
    schedule: [
      { smallBlind: 25, bigBlind: 50, minutes: 0.25 },
      { smallBlind: 75, bigBlind: 150, minutes: 0.25, ante: 15 },
      { smallBlind: 200, bigBlind: 400, minutes: 0.25, ante: 40 },
      { smallBlind: 500, bigBlind: 1000, minutes: 0.25, ante: 100 },
      { smallBlind: 1200, bigBlind: 2400, minutes: 99, ante: 250 },
    ],
  },
  deep: {
    label: 'Deep (6 min)',
    schedule: [
      { smallBlind: 5, bigBlind: 10, minutes: 6 },
      { smallBlind: 10, bigBlind: 20, minutes: 6 },
      { smallBlind: 20, bigBlind: 40, minutes: 6 },
      { smallBlind: 40, bigBlind: 80, minutes: 6, ante: 10 },
      { smallBlind: 80, bigBlind: 160, minutes: 6, ante: 20 },
      { smallBlind: 150, bigBlind: 300, minutes: 6, ante: 40 },
      { smallBlind: 300, bigBlind: 600, minutes: 99, ante: 75 },
    ],
  },
};

export function AdminTournamentsPage() {
  const [list, setList] = useState([]);
  const [botLevel, setBotLevel] = useState(7);
  const [botCount, setBotCount] = useState(6);
  const [startAt, setStartAt] = useState(''); // inicio programado (opcional)

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(torneoSchema),
    defaultValues: { name: 'Torneo de prueba', maxPlayers: 18, buyIn: 100, bounty: 0, addedPrize: 0, speed: 'turbo' },
  });
  const speed = watch('speed');

  async function load() {
    try { const { data } = await api.get('/tournaments'); setList(data); } catch {}
  }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  async function create(values) {
    try {
      await api.post('/tournaments', {
        name: values.name, maxPlayers: values.maxPlayers, buyIn: values.buyIn,
        bounty: values.bounty || 0, addedPrize: values.addedPrize || 0,
        blindSchedule: SPEEDS[values.speed]?.schedule || null,
        startsAt: startAt || null,
      });
      toast.success(startAt ? 'Torneo programado' : 'Torneo creado');
      setStartAt('');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Error al crear torneo'); }
  }
  async function fill(id) {
    try {
      const { data } = await api.post(`/tournaments/${id}/bots`, { level: botLevel, count: botCount });
      toast.success(`${data.added} bots agregados${data.started ? ' — ¡torneo iniciado!' : ''}`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Error al agregar bots'); }
  }
  async function start(id) {
    try { await api.post(`/tournaments/${id}/start`); toast.success('Torneo iniciado'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Error al iniciar'); }
  }

  return (
    <AdminNav>
      <div className="max-w-3xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-1">🏆 Torneos Sit&Go</h1>
        <p className="text-sm text-gray-400 mb-6">Crea un campeonato, rellénalo con bots y arranca. Los testers se inscriben desde el lobby.</p>

        {/* Crear — react-hook-form + Zod con errores inline */}
        <form onSubmit={handleSubmit(create)} className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 space-y-3">
          <h2 className="font-bold text-sm">Crear torneo</h2>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="t-name" className="text-[10px] text-gray-500">Nombre</Label>
              <Input id="t-name" placeholder="Nombre del torneo" {...register('name')}
                aria-invalid={!!errors.name} />
              {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name.message}</p>}
            </div>
            <div className="w-28">
              <Label htmlFor="t-max" className="text-[10px] text-gray-500">Jugadores (2–30)</Label>
              <Input id="t-max" type="number" {...register('maxPlayers')} aria-invalid={!!errors.maxPlayers} />
              {errors.maxPlayers && <p className="text-red-400 text-xs mt-1">{errors.maxPlayers.message}</p>}
            </div>
            <div className="w-28">
              <Label htmlFor="t-buyin" className="text-[10px] text-gray-500">Buy-in</Label>
              <Input id="t-buyin" type="number" {...register('buyIn')} aria-invalid={!!errors.buyIn} />
              {errors.buyIn && <p className="text-red-400 text-xs mt-1">{errors.buyIn.message}</p>}
            </div>
          </div>
          <div className="flex gap-3 flex-wrap">
            <div className="w-40">
              <Label className="text-[10px] text-gray-500">Velocidad de ciegas</Label>
              <select
                value={speed}
                onChange={e => setValue('speed', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-2 text-sm"
              >
                {Object.entries(SPEEDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="w-32">
              <Label htmlFor="t-bounty" className="text-[10px] text-gray-500">Bounty por cabeza</Label>
              <Input id="t-bounty" type="number" {...register('bounty')} />
              <p className="text-[10px] text-gray-500 mt-1">Parte del buy-in que cobra quien elimina</p>
            </div>
            <div className="w-32">
              <Label htmlFor="t-added" className="text-[10px] text-gray-500">Premio añadido</Label>
              <Input id="t-added" type="number" {...register('addedPrize')} />
              <p className="text-[10px] text-gray-500 mt-1">Con buy-in 0 = freeroll</p>
            </div>
          </div>
          <div>
            <Label htmlFor="t-start" className="text-[10px] text-gray-500">
              Inicio programado (opcional) — a esta hora se rellena con bots y arranca solo
            </Label>
            <Input id="t-start" type="datetime-local" value={startAt}
              onChange={e => setStartAt(e.target.value)} className="w-full" />
            <p className="text-[10px] text-gray-500 mt-1">
              Déjalo vacío para arrancar manualmente o al llenarse.
            </p>
          </div>
          <Button type="submit" disabled={isSubmitting} className="font-bold">
            {isSubmitting ? 'Creando...' : 'Crear torneo'}
          </Button>
        </form>

        {/* Ajustes de relleno con bots */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 flex items-end gap-3">
          <div className="flex-1">
            <label className="text-xs text-gray-400 uppercase font-bold">Nivel de bots a agregar</label>
            <div className="flex gap-1 mt-1">
              {LEVELS.map(n => (
                <button key={n} onClick={() => setBotLevel(n)}
                  className={`flex-1 py-1.5 rounded text-sm font-bold ${botLevel === n ? 'bg-yellow-600 text-black' : 'bg-gray-800 text-gray-400'}`}>{n}</button>
              ))}
            </div>
          </div>
          <div className="w-20">
            <label className="text-[10px] text-gray-500 block">Cantidad</label>
            <input type="number" min={1} max={30} value={botCount} onChange={e => setBotCount(Number(e.target.value))}
              className="w-full bg-gray-800 rounded-lg px-3 py-1.5 text-sm" />
          </div>
        </div>

        {/* Lista */}
        <h2 className="font-bold mb-2">Torneos abiertos / en curso</h2>
        <div className="space-y-2">
          {list.length === 0 ? <p className="text-sm text-gray-500">Ninguno todavía.</p> : list.map(t => (
            <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-bold text-sm">{t.name}
                    <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full ${t.status === 'running' ? 'bg-green-900 text-green-300' : 'bg-sky-900 text-sky-300'}`}>{t.status}</span>
                  </div>
                  <div className="text-xs text-gray-400">{t.registered}/{t.max_players} inscritos · buy-in {t.buy_in} · bote {t.prize_pool}</div>
                  {t.starts_at && t.status === 'registering' && (
                    <div className="text-xs text-yellow-300 mt-0.5">🕐 Empieza: {new Date(t.starts_at).toLocaleString()}</div>
                  )}
                </div>
                {t.status === 'registering' && (
                  <div className="flex gap-2">
                    <button onClick={() => fill(t.id)} className="text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg">+ Bots nivel {botLevel}</button>
                    <button onClick={() => start(t.id)} className="text-xs bg-green-700 hover:bg-green-600 px-3 py-1.5 rounded-lg font-bold">Iniciar</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AdminNav>
  );
}
