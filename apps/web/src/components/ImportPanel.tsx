import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportReport } from '@runcoach/shared';
import { importFile } from '../imports-api.js';

export function ImportPanel() {
  const queryClient = useQueryClient();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [fitFile, setFitFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const mutation = useMutation({
    mutationFn: ({ file, type }: { file: File; type: 'csv' | 'fit' }) => importFile(file, type),
    onSuccess: async (result) => {
      setReport(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['activities'] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
        queryClient.invalidateQueries({ queryKey: ['imports'] }),
      ]);
    },
  });
  return (
    <section className="mb-6 grid gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5 md:grid-cols-2">
      <FilePicker
        title="导入活动 CSV"
        accept=".csv,text/csv"
        file={csvFile}
        busy={mutation.isPending}
        onFile={setCsvFile}
        onImport={() => csvFile && mutation.mutate({ file: csvFile, type: 'csv' })}
      />
      <FilePicker
        title="导入 FIT"
        accept=".fit,application/octet-stream"
        file={fitFile}
        busy={mutation.isPending}
        onFile={setFitFile}
        onImport={() => fitFile && mutation.mutate({ file: fitFile, type: 'fit' })}
      />
      <div aria-live="polite" className="md:col-span-2">
        {mutation.isPending && <p className="text-emerald-300">正在导入，请稍候…</p>}
        {mutation.error && <p className="text-red-400">{mutation.error.message}</p>}
      </div>
      {report && (
        <div className="rounded-lg bg-slate-950 p-4 text-sm md:col-span-2">
          <p className="font-semibold">导入报告 · {report.sourceType}</p>
          {report.items.map((item) => (
            <p key={item.itemId} className="mt-2 text-slate-300">
              <span className="mr-2 rounded bg-slate-800 px-2 py-1">{item.outcome}</span>
              {item.message}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

interface FilePickerProps {
  title: string;
  accept: string;
  file: File | null;
  busy: boolean;
  onFile: (file: File | null) => void;
  onImport: () => void;
}
function FilePicker({ title, accept, file, busy, onFile, onImport }: FilePickerProps) {
  return (
    <div>
      <h2 className="font-semibold">{title}</h2>
      <input
        aria-label={title}
        type="file"
        accept={accept}
        disabled={busy}
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        className="mt-3 block w-full text-sm text-slate-400"
      />
      <p className="mt-2 min-h-5 text-xs text-slate-400">
        {file?.name ?? '请先选择文件，然后点击“开始导入”。'}
      </p>
      <button
        type="button"
        disabled={file === null || busy}
        onClick={onImport}
        className="mt-3 rounded bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-40"
      >
        {busy ? '导入中…' : '开始导入'}
      </button>
    </div>
  );
}
