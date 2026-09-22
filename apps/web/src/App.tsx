import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { ActivitiesPage } from './pages/ActivitiesPage.js';
import { ActivityDetailPage } from './pages/ActivityDetailPage.js';
import { ImportsPage } from './pages/ImportsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

function Layout() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-4 py-2 text-sm font-medium ${isActive ? 'bg-emerald-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'}`;
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <NavLink to="/activities" className="text-lg font-bold text-emerald-400">
            RunCoach Local
          </NavLink>
          <nav className="flex gap-1" aria-label="主导航">
            <NavLink to="/activities" className={linkClass}>
              活动
            </NavLink>
            <NavLink to="/imports" className={linkClass}>
              导入
            </NavLink>
            <NavLink to="/settings" className={linkClass}>
              设置
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-7">
        <Outlet />
      </main>
    </div>
  );
}
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/activities" replace />} />
        <Route path="activities" element={<ActivitiesPage />} />
        <Route path="activities/:activityId" element={<ActivityDetailPage />} />
        <Route path="imports" element={<ImportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/activities" replace />} />
      </Route>
    </Routes>
  );
}
