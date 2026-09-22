import { ImportHistoryPanel } from '../components/ImportHistoryPanel.js';
import { ImportPanel } from '../components/ImportPanel.js';
import { PendingImportsPanel } from '../components/PendingImportsPanel.js';
export function ImportsPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold">导入管理</h1>
        <p className="mt-2 text-slate-400">上传 CSV/FIT、处理模糊匹配并查看导入历史。</p>
      </header>
      <ImportPanel />
      <PendingImportsPanel />
      <ImportHistoryPanel />
    </div>
  );
}
