const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { matches, bindable, codexId, noTab } = require('./match.cjs');

function activate(context) {
  const bindings = new Map(), clientId = randomUUID();
  let busy = false, disposed = false;
  async function connection() {
    const configured = vscode.workspace.getConfiguration('agentMonitor').get('root');
    const candidates = configured ? [configured] : [path.join(os.homedir(), 'VS Code Dev', 'Agent Monitor')];
    if (!configured) for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let dir = folder.uri.fsPath;
      for (let i = 0; i < 5; i++) { candidates.push(dir, path.join(dir, 'Agent Monitor')); const parent = path.dirname(dir); if (dir === parent) break; dir = parent; }
    }
    for (const root of candidates) {
      try {
        let config = {};
        try { config = JSON.parse(await fs.readFile(path.join(root, 'config', 'agent-monitor.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const token = (await fs.readFile(path.join(config.dataDir ?? path.join(root, 'data'), 'token'), 'utf8')).trim();
        const port = config.port ?? 4317;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) continue;
        return async (endpoint, body) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
            method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
            headers: { 'x-agent-monitor-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          if (!r.ok) throw new Error('Monitor request failed');
          return r.json();
        };
      } catch { /* Try another workspace ancestor; never log authentication. */ }
    }
    throw new Error('Set Agent Monitor: Root to your monitor repository path');
  }
  const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);
  const forget = tab => { for (const [id, linked] of bindings) if (tab === linked) bindings.delete(id); };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of [...event.closed, ...event.changed]) forget(tab);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('agentMonitor.unlinkSessionTabs', () => {
    bindings.clear(); vscode.window.showInformationMessage('Agent Monitor chat links cleared.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('agentMonitor.linkSessionTab', async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return;
    if (codexId(tab.input)) return vscode.window.showInformationMessage('This Codex tab is identified automatically by its session ID.');
    if (!bindable(tab.input, 'vscode-hooks') && !bindable(tab.input, 'kilo-local')) {
      return vscode.window.showWarningMessage('Open a dedicated Claude or Kilo chat editor tab first. Sidebars, terminals and shared Agent Manager tabs cannot be linked.');
    }
    try {
      const api = await connection(), state = await api('snapshot');
      const items = state.sessions.filter(s => bindable(tab.input, s.source)).map(s => ({
        label: s.title, description: s.runtimeSessionId, detail: `${s.cwd} | ${s.runtimeState}`, session: s
      }));
      const item = await vscode.window.showQuickPick(items, { title: 'Link this dedicated chat tab to its exact session',
        placeHolder: 'Match the session ID in the chat. Link expires if the tab changes or VS Code reloads.' });
      if (!item || !allTabs().includes(tab)) return;
      bindings.set(item.session.id, tab);
      vscode.window.showInformationMessage('Tab linked. Clear finished will archive this conversation before closing this tab. Relink if you switch chats inside it.');
    } catch { vscode.window.showErrorMessage('Cannot connect to Agent Monitor. Check the running monitor and Agent Monitor: Root setting.'); }
  }));
  async function poll() {
    if (busy || disposed) return;
    busy = true;
    try {
      const api = await connection(), jobs = await api('vscode/pending');
      for (const job of jobs) {
        if (disposed) break;
        const tabs = allTabs().filter(tab => matches(tab, job, bindings));
        if (!tabs.length) {
          // Give a window that does hold the tab time to claim first.
          if (!(Date.now() >= job.expiresAt - 25000) ||!noTab(allTabs(), job, bindings)) continue;
          const claim = await api(`vscode/jobs/${job.id}/claim`, { clientId });
          if (!claim.ok) continue;
          const none = noTab(allTabs(), job, bindings);
          await api(`vscode/jobs/${job.id}/ack`, { clientId, closed: false, noTab: none });
          continue;
        }
        if (tabs.some(tab => tab.isDirty)) continue;
        const claim = await api(`vscode/jobs/${job.id}/claim`, { clientId });
        if (!claim.ok) continue;
        let closed = false;
        try {
          // Recheck after the network round trip. Close exact Tab objects only.
          if (tabs.every(tab => allTabs().includes(tab) && !tab.isDirty && matches(tab, job, bindings))) {
            closed = await vscode.window.tabGroups.close(tabs, true);
            closed = closed && tabs.every(tab => !allTabs().includes(tab));
            if (closed) for (const tab of tabs) forget(tab);
          }
        } finally { await api(`vscode/jobs/${job.id}/ack`, { clientId, closed }); }
      }
    } catch { /* Monitor offline or another window claimed the job; retry. */ }
    finally { busy = false; }
  }
  const timer = setInterval(() => void poll(), 1000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); bindings.clear(); } });
  void poll();
}
module.exports = { activate };
