import { useEffect, useState } from 'react';
import { AdminNav } from './AdminNav';
import api from '../../services/api';
import { Card, CardHeader, CardContent, CardDescription } from '@/components/ui/card';

// Panorama en vivo del sistema: jugadores, economía, mesas y torneos.
export function AdminDashboardPage() {
  const [data, setData] = useState(null);

  async function load() {
    try { const { data } = await api.get('/admin/dashboard'); setData(data); } catch {}
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  if (!data) return <AdminNav><p className="p-8 text-gray-500">Cargando…</p></AdminNav>;

  const KPIS = [
    { label: 'Jugadores humanos', value: data.players.humanos },
    { label: 'Bots registrados', value: data.players.bots },
    { label: 'Fichas en circulación', value: data.chipsCirculacion.toLocaleString() },
    { label: 'Manos hoy', value: data.manosHoy },
    { label: 'Manos totales', value: data.manosTotal.toLocaleString() },
    { label: 'Bots activos ahora', value: data.botsActivos },
  ];

  return (
    <AdminNav>
      <div className="max-w-5xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-4">📊 Dashboard</h1>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
          {KPIS.map(k => (
            <Card key={k.label}>
              <CardHeader className="pb-0">
                <CardDescription className="text-[10px] uppercase tracking-wider">{k.label}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-yellow-400">{k.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h2 className="font-bold mb-2">🃏 Mesas en juego ({data.mesasVivas.length})</h2>
            <div className="space-y-1.5">
              {data.mesasVivas.length === 0 && <p className="text-sm text-gray-500">Ninguna ahora.</p>}
              {data.mesasVivas.map(m => (
                <div key={m.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm flex justify-between">
                  <span className="truncate">{m.isTournament ? '🏆 ' : ''}{m.name}</span>
                  <span className="text-gray-400 shrink-0 ml-2">{m.seated}/{m.maxSeats} · mano #{m.handNumber}</span>
                </div>
              ))}
            </div>

            <h2 className="font-bold mb-2 mt-6">🏆 Torneos abiertos/en curso</h2>
            <div className="space-y-1.5">
              {data.torneos.length === 0 && <p className="text-sm text-gray-500">Ninguno.</p>}
              {data.torneos.map((t, i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm flex justify-between">
                  <span className="truncate">{t.name}</span>
                  <span className={`shrink-0 ml-2 ${t.status === 'running' ? 'text-green-400' : 'text-sky-400'}`}>
                    {t.status} · {t.regs} insc · bote {Math.round(t.prize_pool)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="font-bold mb-2">💸 Últimas transacciones</h2>
            <div className="space-y-1">
              {data.ultimasTransacciones.map((tx, i) => (
                <div key={i} className="flex justify-between text-xs px-3 py-1.5 bg-gray-900/60 rounded">
                  <span className="text-gray-300 truncate">{tx.nickname} · {tx.reason}</span>
                  <span className={`font-mono shrink-0 ml-2 ${Number(tx.delta) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {Number(tx.delta) >= 0 ? '+' : ''}{Math.round(tx.delta)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AdminNav>
  );
}
