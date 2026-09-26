import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { ActivitiesPage } from './pages/ActivitiesPage.js';
import { ActivityDetailPage } from './pages/ActivityDetailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { DailyStatusPage } from './pages/DailyStatusPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ImportsPage } from './pages/ImportsPage.js';
import { CoachPage } from './pages/CoachPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TrainingReviewPage } from './pages/TrainingReviewPage.js';
import { TrendsPage } from './pages/TrendsPage.js';

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
          <nav className="flex flex-wrap gap-1" aria-label="主导航">
            <NavLink to="/" className={linkClass}>
              概览
            </NavLink>
            <NavLink to="/trends" className={linkClass}>
              趋势
            </NavLink>
            <NavLink to="/calendar" className={linkClass}>
              日历
            </NavLink>
            <NavLink to="/daily-status" className={linkClass}>
              状态
            </NavLink>
            <NavLink to="/review" className={linkClass}>
              回顾
            </NavLink>
            <NavLink to="/coach" className={linkClass}>
              教练
            </NavLink>
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
        <Route index element={<DashboardPage />} />
        <Route path="trends" element={<TrendsPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="daily-status" element={<DailyStatusPage />} />
        <Route path="review" element={<TrainingReviewPage />} />
        <Route path="coach" element={<CoachPage />} />
        <Route path="activities" element={<ActivitiesPage />} />
        <Route path="activities/:activityId" element={<ActivityDetailPage />} />
        <Route path="imports" element={<ImportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/activities" replace />} />
      </Route>
    </Routes>
  );
}
