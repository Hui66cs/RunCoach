import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (props.open) ref.current?.showModal();
    else ref.current?.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      onCancel={props.onCancel}
      className="rounded-xl bg-slate-900 p-0 text-slate-100 backdrop:bg-black/70"
    >
      <div className="max-w-md p-6">
        <h2 className="text-xl font-semibold">{props.title}</h2>
        <p className="mt-3 text-slate-300">{props.description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.busy}
            className="rounded border border-slate-600 px-4 py-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy}
            className="rounded bg-emerald-500 px-4 py-2 font-medium text-slate-950 disabled:opacity-50"
          >
            {props.busy ? '处理中…' : '确认'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
