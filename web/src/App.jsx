import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { LobbyPage } from './pages/LobbyPage';
import { TablePage } from './pages/TablePage';
import { HistoryPage } from './pages/HistoryPage';
import { StatsPage } from './pages/StatsPage';
import { ProfilePage } from './pages/ProfilePage';
import { HandReplayPage } from './pages/HandReplayPage';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage';
import { AdminBotsPage } from './pages/admin/AdminBotsPage';
import { AdminTournamentsPage } from './pages/admin/AdminTournamentsPage';
import { AdminAccuracyPage } from './pages/admin/AdminAccuracyPage';

export default function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <Toaster theme="dark" position="top-center" richColors closeButton />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LobbyPage />} />
            <Route path="/table/:id" element={<TablePage />} />
            <Route path="/historial" element={<HistoryPage />} />
            <Route path="/estadisticas" element={<StatsPage />} />
            <Route path="/perfil" element={<ProfilePage />} />
            <Route path="/replay/:id" element={<HandReplayPage />} />
            <Route path="/replay/shared/:token" element={<HandReplayPage shared />} />
            <Route path="/admin" element={<AdminDashboardPage />} />
            <Route path="/admin/bots" element={<AdminBotsPage />} />
            <Route path="/admin/torneos" element={<AdminTournamentsPage />} />
            <Route path="/admin/precision" element={<AdminAccuracyPage />} />
          </Routes>
        </BrowserRouter>
      </SocketProvider>
    </AuthProvider>
  );
}
