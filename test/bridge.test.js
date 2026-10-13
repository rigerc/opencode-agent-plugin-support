import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import plugin, {
  loadSettings, matcherHits, conditionHits, toClaudeTool, createBridge, setupV1, setupV2,
} from '../index.js';

const helper = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-compat-'));
  const project = path.join(dir, 'project'), home = path.join(dir, 'home');
  fs.mkdirSync(project, {recursive:true});
  fs.mkdirSync(home, {recursive:true});
  return {dir, project, home, calls:path.join(dir, 'calls.jsonl')};
}
function hook(w, mode, extra = {}) {
  return {type:'command', command:process.execPath, args:[helper, mode, w.calls], ...extra};
}
function group(event, item, matcher) {
  return {[event]:[{...(matcher ? {matcher} : {}), hooks:[item]}]};
}
function settings(file, hooks, extra = {}) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, JSON.stringify({hooks, ...extra}));
}
function calls(w) {
  if (!fs.existsSync(w.calls)) return [];
  return fs.readFileSync(w.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function mock(w) {
  const hooks = new Map();
  const register = (prefix) => ({hook:async (key, handler) => {hooks.set(prefix + ':' + key, handler);}});
  const ctx = {options:{home:w.home}, location:{directory:w.project},
    session:register('session'), tool:register('tool'), permission:register('permission')};
  return {ctx, invoke:(key, arg) => hooks.get(key)(arg)};
}

describe('configuration', () => {
  it('merges global, project, then project-local in order', () => {
    const w = workspace();
    const files = [
      path.join(w.home, '.claude', 'settings.json'),
      path.join(w.project, '.claude', 'settings.json'),
      path.join(w.project, '.claude', 'settings.local.json'),
    ];
    files.forEach((file, i) => settings(file, group('PreToolUse', hook(w, String(i)), 'Bash')));
    const out = loadSettings({home:w.home, project:w.project});
    assert.deepEqual(out.hooks.PreToolUse.map((item) => item.scope), ['global','project','local']);
    assert.equal(loadSettings({home:w.home, project:w.project, scopes:{global:false}}).hooks.PreToolUse.length, 2);
  });
  it('skips malformed and unsupported settings', () => {
    const w = workspace();
    fs.mkdirSync(path.join(w.home,'.claude'));
    fs.writeFileSync(path.join(w.home,'.claude','settings.json'), '{invalid');
    settings(path.join(w.project,'.claude','settings.json'), {
      PreToolUse:[{hooks:[hook(w,'update'), {type:'prompt', prompt:'ignored'}]}],
    });
    const warnings = [];
    const out = loadSettings({home:w.home,project:w.project,warn:(msg)=>warnings.push(msg)});
    assert.equal(out.hooks.PreToolUse.length, 1);
    assert.equal(out.diagnostics.length, 1);
    assert.equal(warnings.length, 1);
  });
  it('honors highest-precedence explicit disableAllHooks', () => {
    const w = workspace();
    settings(path.join(w.home,'.claude','settings.json'),group('PreToolUse',hook(w,'deny')),{disableAllHooks:true});
    assert.equal(loadSettings({home:w.home,project:w.project}).disabled, true);
    settings(path.join(w.project,'.claude','settings.json'),{},{disableAllHooks:false});
    assert.equal(loadSettings({home:w.home,project:w.project}).hooks.PreToolUse.length, 1);
  });
});

describe('filtering', () => {
  it('maps OpenCode tool IDs to Claude names', () => {
    assert.equal(toClaudeTool('shell'), 'Bash');
    assert.equal(toClaudeTool('patch'), 'Edit');
    assert.equal(toClaudeTool('subagent'), 'Task');
  });
  it('matches regex and literal tool alternatives without false positives', () => {
    assert.equal(matcherHits('Write|Edit','Edit'), true);
    assert.equal(matcherHits('Edit','NotebookEdit'), false);
    assert.equal(matcherHits('mcp__db__.*','mcp__db__query'), true);
  });
  it('honors conditional command filters conservatively', () => {
    assert.equal(conditionHits('Bash(git *)','Bash',{command:'git status'}), true);
    assert.equal(conditionHits('Bash(git *)','Bash',{command:'rm -rf tmp'}), false);
    assert.equal(conditionHits('unknown','Bash',{command:'anything'}), false);
  });
});

describe('OpenCode v2', () => {
  it('executes hooks from both scopes using project cwd and Claude stdin', async () => {
    const w = workspace();
    settings(path.join(w.home,'.claude','settings.json'), group('PreToolUse',hook(w,'noop'),'Bash'));
    settings(path.join(w.project,'.claude','settings.json'),group('PreToolUse',hook(w,'update'),'Bash'));
    const m = mock(w); await setupV2(m.ctx);
    const event = {sessionID:'s', id:'call', tool:'shell', input:{command:'echo old'}};
    await m.invoke('tool:execute.before',event);
    assert.equal(event.input.command, 'echo safe');
    assert.equal(calls(w).length, 2);
    assert.equal(calls(w)[0].cwd, w.project);
    assert.equal(calls(w)[0].envProject, w.project);
    assert.equal(calls(w)[0].payload.tool_name, 'Bash');
  });
  it('blocks PreToolUse and UserPromptSubmit denial', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'), {
      ...group('PreToolUse',hook(w,'deny'),'Bash'),
      ...group('UserPromptSubmit',hook(w,'exit2')),
    });
    const m = mock(w); await setupV2(m.ctx);
    await assert.rejects(() => m.invoke('tool:execute.before',{sessionID:'s',tool:'shell',input:{}}), /policy denied/);
    await assert.rejects(() => m.invoke('session:prompt',{sessionID:'s',prompt:{text:'bad'}}), /blocked via exit 2/);
  });
  it('executes SessionStart once and adds prompt and tool context', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'), {
      ...group('SessionStart',hook(w,'plain'),'startup'),
      ...group('UserPromptSubmit',hook(w,'context')),
      ...group('PostToolUse',hook(w,'replace'),'Bash'),
    });
    const m = mock(w); await setupV2(m.ctx);
    const session = {sessionID:'s',system:[]};
    await m.invoke('session:context',session);
    await m.invoke('session:context',session);
    assert.equal(session.system.length, 1);
    assert.equal(session.system[0].text,'context from startup');
    const prompt = {sessionID:'s',prompt:{text:'hello'}};
    await m.invoke('session:prompt',prompt);
    assert.match(prompt.prompt.text,/additional hook context/);
    const after = {sessionID:'s',tool:'shell',status:'completed',input:{},result:{content:'original'}};
    await m.invoke('tool:execute.after',after);
    assert.equal(after.result.content,'replaced output\n\nfrom after');
    assert.equal(calls(w).filter((c) => c.payload.hook_event_name === 'SessionStart').length,1);
  });
  it('honors PermissionRequest allow and deny decisions', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'), group('PermissionRequest',hook(w,'allow'),'Bash'));
    const m = mock(w); await setupV2(m.ctx);
    const allow = {sessionID:'s',action:'shell',resources:['*'],effect:'ask'};
    await m.invoke('permission:evaluate',allow);
    assert.equal(allow.effect,'allow');
    settings(path.join(w.project,'.claude','settings.json'),group('PermissionRequest',hook(w,'permission-deny'),'Bash'));
    const n = mock(w); await setupV2(n.ctx);
    const deny = {sessionID:'s',action:'shell',effect:'ask'};
    await n.invoke('permission:evaluate',deny);
    assert.equal(deny.effect,'deny');
  });
  it('fails closed on a PreToolUse timeout', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'),group('PreToolUse',hook(w,'slow',{timeout:0.05}),'Bash'));
    const m = mock(w); await setupV2(m.ctx);
    await assert.rejects(() => m.invoke('tool:execute.before',{sessionID:'s',tool:'shell',input:{}}), /timed out/);
  });
  it('applies onFailure block to failed commands', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'),group('PreToolUse',hook(w,'fail',{onFailure:'block'}),'Bash'));
    const m = mock(w); await setupV2(m.ctx);
    await assert.rejects(() => m.invoke('tool:execute.before',{sessionID:'s',tool:'shell',input:{}}), /blocked/);
  });
});
describe('entrypoint and v1', () => {
  it('exports dual v1/v2 entrypoint', () => {
    assert.equal(plugin.setup,setupV2);
    assert.equal(plugin.server,setupV1);
  });
  it('updates a v1 tool call', async () => {
    const w = workspace();
    settings(path.join(w.project,'.claude','settings.json'),group('PreToolUse',hook(w,'update'),'Bash'));
    const pluginV1 = await setupV1({worktree:w.project,options:{home:w.home}});
    const output = {args:{command:'original'}};
    await pluginV1['tool.execute.before']({tool:'bash',sessionID:'s',callID:'c'},output);
    assert.equal(output.args.command,'echo safe');
  });
});
