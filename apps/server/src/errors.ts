export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unknown import error';
  return raw
    .replace(/[A-Za-z]:\\\S+/g, '[local path]')
    .replace(/(?:api-key|authorization|cookie)\s*[:=]\s*\S+/gi, '[secret redacted]')
    .slice(0, 1000);
}
