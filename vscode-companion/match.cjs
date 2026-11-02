// These helpers intentionally do not match labels or the active editor.
function codexId(input) {
  const uri = input?.uri;
  if (input?.viewType !== 'chatgpt.conversationEditor' || uri?.scheme !== 'openai-codex' || uri.authority !== 'route') return null;
  const match = /^\/local\/([\w-]+)\/?$/.exec(uri.path);
  return match?.[1] ?? null;
}
function bindable(input, source) {
  return source === 'vscode-hooks' && input?.viewType === 'claudeVSCodePanel'
    || source === 'kilo-local' && input?.viewType === 'kilo-code.new.TabPanel';
}
function matches(tab, job, bindings) {
  if (job.source === 'codex-local') return codexId(tab.input) === job.runtimeSessionId;
  return bindable(tab.input, job.source) && bindings.get(job.sessionId) === tab;
}
// True only when no open tab could be this job's: Codex tabs carry their ID,
// but any unlinked Claude/Kilo tab might be the session, so stay ambiguous.
function noTab(tabs, job, bindings) {
  if (tabs.some(tab => matches(tab, job, bindings))) return false;
  if (job.source === 'codex-local') return true;
  const linked = new Set(bindings.values());
  return !tabs.some(tab => bindable(tab.input, job.source) && !linked.has(tab));
}
module.exports = { codexId, bindable, matches, noTab };
