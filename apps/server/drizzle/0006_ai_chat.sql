-- M7 Batch 2: persistent conversational coach storage.
-- Single-user local application: no athlete/owner columns by design.
-- Chat history is user-editable data, not an immutable import source.

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX chat_messages_session_idx ON chat_messages (session_id, created_at);
CREATE INDEX chat_sessions_updated_idx ON chat_sessions (updated_at);
