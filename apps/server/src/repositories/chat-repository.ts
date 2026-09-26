import { randomUUID } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { chatMessages, chatSessions } from '../db/schema.js';
import type { RunCoachDatabase } from '../db/client.js';

export interface ChatSessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/**
 * Persistent chat storage for the conversational coach (M7 Batch 2).
 * Single-user; sessions and messages are user-editable data (not immutable
 * import sources). All writes update the parent session's `updated_at` so
 * the session list stays newest-activity-first.
 */
export class ChatRepository {
  constructor(private readonly db: RunCoachDatabase) {}

  createSession(title: string, now: string): ChatSessionRow {
    const row = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(chatSessions).values(row).run();
    return { ...row, messageCount: 0 };
  }

  listSessions(): ChatSessionRow[] {
    const rows = this.db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        createdAt: chatSessions.createdAt,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .orderBy(desc(chatSessions.updatedAt))
      .all();
    const counts = this.db
      .select({ sessionId: chatMessages.sessionId, n: sql<number>`count(*)` })
      .from(chatMessages)
      .groupBy(chatMessages.sessionId)
      .all();
    const countBySession = new Map(counts.map((row) => [row.sessionId, Number(row.n)]));
    return rows.map((row) => ({
      ...row,
      messageCount: countBySession.get(row.id) ?? 0,
    }));
  }

  getSession(sessionId: string): ChatSessionRow | null {
    const row = this.db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        createdAt: chatSessions.createdAt,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .get();
    if (row === undefined) return null;
    return {
      ...row,
      messageCount: this.listMessages(sessionId).length,
    };
  }

  deleteSession(sessionId: string): boolean {
    const result = this.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
    return result.changes > 0;
  }

  appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    now: string,
  ): ChatMessageRow {
    const row = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: now,
    };
    this.db.insert(chatMessages).values(row).run();
    this.db
      .update(chatSessions)
      .set({ updatedAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();
    return row;
  }

  /** All messages of a session, oldest first. */
  listMessages(sessionId: string): ChatMessageRow[] {
    return this.db
      .select({
        id: chatMessages.id,
        sessionId: chatMessages.sessionId,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .all()
      .map((row) => ({ ...row, role: row.role as 'user' | 'assistant' }));
  }

  /** The most recent `limit` messages of a session, oldest first — the
   * bounded history window sent to the model. */
  recentMessages(sessionId: string, limit: number): ChatMessageRow[] {
    const rows = this.db
      .select({
        id: chatMessages.id,
        sessionId: chatMessages.sessionId,
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit)
      .all();
    return rows.reverse().map((row) => ({ ...row, role: row.role as 'user' | 'assistant' }));
  }
}
