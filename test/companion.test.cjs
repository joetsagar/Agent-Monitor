const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { matches, bindable, codexId, noTab } = require('../vscode-companion/match.cjs');

test('noTab is true only when no open tab could belong to the job', () => {
  const codex = { source: 'codex-local', runtimeSessionId: 'one', sessionId: 'm1' };
  const claude = { source: 'vscode-hooks', runtimeSessionId: 'two', sessionId: 'm2' };
  const codexTab = { input: { viewType: 'chatgpt.conversationEditor', uri: { scheme: 'openai-codex', authority: 'route', path: '/local/one' } } };
  const otherCodex = { input: { viewType: 'chatgpt.conversationEditor', uri: { scheme: 'openai-codex', authority: 'route', path: '/local/other' } } };
  const claudeTab = { input: { viewType: 'claudeVSCodePanel' } };
  assert.equal(noTab([otherCodex, claudeTab], codex, new Map()), true);
  assert.equal(noTab([codexTab], codex, new Map()), false);
  assert.equal(noTab([otherCodex], claude, new Map()), true);
  assert.equal(noTab([claudeTab], claude, new Map()), false, 'an unlinked Claude tab might be this session');
  assert.equal(noTab([claudeTab], claude, new Map([['m9', claudeTab]])), true, 'tab linked to another session');
  assert.equal(noTab([claudeTab], claude, new Map([['m2', claudeTab]])), false);
});

test('companion closes exact linked tabs after a successful claim, acknowledges closure, and ignores dirty/unrelated tabs', async () => {
  for (const [source, viewType] of [['codex-local', 'chatgpt.conversationEditor'], ['vscode-hooks', 'claudeVSCodePanel'], ['kilo-local', 'kilo-code.new.TabPanel']]) {
    const tab = { input: { viewType, ...(source === 'codex-local' ? { uri: { scheme: 'openai-codex', authority: 'route', path: '/local/session-one' } } : {}) }, isDirty: true };
    const unrelated = { input: { viewType }, isDirty: false };
    let tabs = [tab, unrelated], tick, ack;
    const commands = new Map(), actions = [];
    const job = { id: 'job-one', source, runtimeSessionId: 'session-one', sessionId: 'monitor-one' };
    const vscode = {
      workspace: { getConfiguration: () => ({ get: () => '/test/monitor' }), workspaceFolders: [] },
      window: {
        tabGroups: { get all() { return [{ tabs }]; }, activeTabGroup: { activeTab: tab }, onDidChangeTabs: () => ({ dispose() {} }),
          close: async exact => { assert.equal(exact.length, 1); assert.equal(exact[0], tab); actions.push('close'); tabs = tabs.filter(t => !exact.includes(t)); return true; } },
        showQuickPick: async items => items[0], showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {}
      },
      commands: { registerCommand: (id, callback) => { commands.set(id, callback); return { dispose() {} }; } }
    };
    const context = vm.createContext({ module: { exports: {} },
      require: name => name === 'vscode' ? vscode : name === './match.cjs' ? { matches, bindable, codexId, noTab } : name === 'node:fs/promises'
        ? { readFile: async file => file.endsWith('token') ? 'TEST-TOKEN' : '{}' } : require(name),
      AbortSignal, setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
      fetch: async (url, options) => {
        assert.equal(options.headers['x-agent-monitor-token'], 'TEST-TOKEN');
        const endpoint = new URL(url).pathname;
        let value;
        if (endpoint.endsWith('/pending')) value = ack ? [] : [job];
        else if (endpoint.endsWith('/snapshot')) value = { sessions: [{ id: job.sessionId, source, title: 'test', runtimeSessionId: job.runtimeSessionId, cwd: '/test', runtimeState: 'idle' }] };
        else if (endpoint.endsWith('/claim')) { actions.push('claim'); value = { ok: true }; }
        else if (endpoint.endsWith('/ack')) { actions.push('ack'); ack = JSON.parse(options.body); value = { ok: true }; }
        else throw new Error('Unexpected endpoint');
        return { ok: true, json: async () => value };
      }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../vscode-companion/extension.cjs'), 'utf8'), context);
    const lifecycle = { subscriptions: [] }; context.module.exports.activate(lifecycle);
    await new Promise(resolve => setImmediate(resolve));
    if (source !== 'codex-local') await commands.get('agentMonitor.linkSessionTab')();
    tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(actions.length, 0, 'dirty tab must never be closed');
    tab.isDirty = false; tick(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(actions, ['claim', 'close', 'ack']);
    assert.equal(ack.closed, true); assert.equal(tabs.length, 1); assert.equal(tabs[0], unrelated);
    for (const disposable of lifecycle.subscriptions) disposable.dispose();
  }
});
