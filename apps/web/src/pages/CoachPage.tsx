import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteCoachSession,
  getAiCoachContext,
  getCoachMessages,
  listCoachSessions,
  sendCoachChat,
} from '../api.js';
import { ApiError } from '../api.js';

type ReplyError = { message: string; stale: boolean };

/** Conversational coach page (M7 Batch 2): persistent multi-turn chat backed
 * by SQLite sessions. Every request is user-triggered; the coach reads the
 * same authorized context snapshot shown on /review and never modifies
 * training data. */
export function CoachPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<ReplyError | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const sessions = useQuery({ queryKey: ['coach-sessions'], queryFn: listCoachSessions });

  const messages = useQuery({
    queryKey: ['coach-messages', activeSessionId],
    queryFn: () => getCoachMessages(activeSessionId!),
    enabled: activeSessionId !== null,
  });

  const chat = useMutation({
    mutationFn: () =>
      sendCoachChat(
        activeSessionId !== null
          ? { message: message.trim(), sessionId: activeSessionId }
          : { message: message.trim() },
      ),
    onSuccess: async (data) => {
      setMessage('');
      setError(null);
      if (activeSessionId === null) setActiveSessionId(data.sessionId);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['coach-sessions'] }),
        client.invalidateQueries({ queryKey: ['coach-messages', data.sessionId] }),
      ]);
    },
    onError: (err) => {
      const stale = err instanceof ApiError && err.code === 'AI_CONTEXT_STALE';
      setError({ message: err.message, stale });
    },
  });

  const removeSession = useMutation({
    mutationFn: deleteCoachSession,
    onSuccess: async (_data, sessionId) => {
      if (activeSessionId === sessionId) setActiveSessionId(null);
      setError(null);
      await client.invalidateQueries({ queryKey: ['coach-sessions'] });
    },
    onError: (err) => {
      setError({ message: err.message, stale: false });
    },
  });

  const aiStatus = useQuery({ queryKey: ['ai-coach-context'], queryFn: getAiCoachContext });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (message.trim() === '' || chat.isPending) return;
    chat.mutate();
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.data, chat.isPending]);

  return (
    <div className="mx-auto flex h-[calc(100vh-9rem)] max-w-5xl flex-col">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">AI 训练助手</h1>
          <p className="text-sm text-slate-400">
            基于你的训练记录、个人纪录与每日状态进行对话。回答由 AI 生成，仅供参考。
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/coach/plan"
            data-testid="coach-plan-draft-link"
            className="rounded bg-purple-500/20 px-4 py-2 text-sm text-purple-200"
          >
            计划草稿
          </Link>
          <button
            type="button"
            onClick={() => {
              setActiveSessionId(null);
              setError(null);
              chat.reset();
            }}
            className="rounded bg-slate-800 px-4 py-2 text-sm"
          >
            新对话
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[16rem_1fr]">
        <aside className="hidden min-h-0 flex-col overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-3 md:flex">
          <h2 className="mb-2 text-xs font-semibold text-slate-400">历史会话</h2>
          {sessions.isLoading && <p className="text-sm text-slate-500">加载中…</p>}
          {sessions.data !== undefined && sessions.data.sessions.length === 0 && (
            <p className="text-sm text-slate-500">还没有会话。</p>
          )}
          <ul className="space-y-1">
            {sessions.data?.sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setActiveSessionId(session.id);
                    setError(null);
                    chat.reset();
                  }}
                  className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
                    activeSessionId === session.id
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {session.title}
                </button>
                <button
                  type="button"
                  aria-label={`删除会话 ${session.title}`}
                  onClick={() => {
                    removeSession.mutate(session.id);
                  }}
                  className="rounded px-1.5 py-1 text-xs text-slate-500 hover:text-red-400"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900">
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
            data-testid="coach-messages"
          >
            {activeSessionId === null && (
              <div className="text-sm text-slate-400">
                <p>开始一个新对话，询问你的训练数据，例如：</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>我最近的跑量和配速怎么样？</li>
                  <li>我的最长一次跑步是多少？</li>
                  <li>最近计划完成情况如何？</li>
                </ul>
                <p className="mt-2">
                  你的训练上下文（含每日状态与备注）会随每次提问发送到 DeepSeek。
                </p>
              </div>
            )}
            {activeSessionId !== null &&
              messages.data?.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-6 ${
                    msg.role === 'user'
                      ? 'ml-auto bg-sky-600/80 text-slate-50'
                      : 'bg-slate-800 text-slate-100'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <span className="mb-1 block text-xs text-purple-300">AI 生成</span>
                  )}
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              ))}
            {chat.isPending && (
              <div className="max-w-[85%] rounded-xl bg-slate-800 px-4 py-2.5 text-sm text-slate-400">
                AI 正在思考…
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error !== null && (
            <p
              className={`mx-4 mb-2 rounded px-3 py-2 text-sm ${
                error.stale ? 'bg-amber-950/40 text-amber-200' : 'bg-red-950/40 text-red-300'
              }`}
              data-testid="coach-error"
            >
              {error.message}
              {!error.stale && (
                <button
                  type="button"
                  onClick={() => chat.mutate()}
                  disabled={chat.isPending}
                  className="ml-2 rounded border border-slate-600 px-2 py-0.5 text-xs"
                >
                  重试
                </button>
              )}
            </p>
          )}

          <form onSubmit={submit} className="flex flex-wrap gap-2 border-t border-slate-800 p-3">
            <input
              type="text"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={2000}
              placeholder={
                aiStatus.data?.aiEnabled === false
                  ? 'AI 回顾未启用，请先在设置页配置'
                  : '询问你的训练数据…'
              }
              aria-label="对话输入"
              className="min-w-0 flex-1 rounded bg-slate-950 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={chat.isPending || message.trim() === ''}
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              发送
            </button>
          </form>
          {aiStatus.data !== undefined && aiStatus.data.aiEnabled === false && (
            <button
              type="button"
              onClick={() => {
                void navigate('/settings');
              }}
              className="m-3 rounded border border-slate-600 px-3 py-1.5 text-xs"
              data-testid="coach-disabled-link"
            >
              前往设置页配置 DeepSeek API key
            </button>
          )}
          <p className="px-3 pb-3 text-xs text-slate-500">
            对话记录保存在本机数据库，可随时删除。AI 回答不是医疗建议，也不会自动修改你的训练计划。
            <Link to="/review" className="ml-1 text-emerald-400 underline">
              返回训练回顾
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
