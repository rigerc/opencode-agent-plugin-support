import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PLUGIN_ID = 'opencode-claude-hooks-compat';
export const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PreCompact', 'Stop'];
const MAX_BYTES = 1024 * 1024;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const object = (x) => isObject(x) ? x : {};
const str = (x) => typeof x === 'string' ? x : '';
const sessionId = (x) => str(x.sessionID ?? x.sessionId ?? x.id);

export function loadSettings({home = os.homedir(), project = process.cwd(), scopes = {}, warn = console.warn} = {}) {
  const entries = [
    ['global', path.join(home, '.claude', 'settings.json')],
    ['project', path.join(project, '.claude', 'settings.json')],
    ['local', path.join(project, '.claude', 'settings.local.json')],
  ];
  const hooks = Object.fromEntries(EVENTS.map((key) => [key, []]));
  const diagnostics = [];
  let disabled = false;
  for (const [scope, file] of entries) {
    if (scopes[scope] === false) continue;
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      diagnostics.push(file + ': ' + error.message);
      warn('[claude-hooks-compat] ' + diagnostics.at(-1));
      continue;
    }
    if (!isObject(settings)) { warn('[claude-hooks-compat] expected object: ' + file); continue; }
    if (typeof settings.disableAllHooks === 'boolean') disabled = settings.disableAllHooks;
    for (const [event, groups] of Object.entries(object(settings.hooks))) {
      if (!EVENTS.includes(event)) {
        diagnostics.push(file + ': unsupported event ' + event);
        continue;
      }
      if (!Array.isArray(groups)) { warn('[claude-hooks-compat] invalid ' + event + ' in ' + file); continue; }
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue;
        for (const handler of group.hooks) {
          if (!isObject(handler) || (handler.type && handler.type !== 'command')) continue;
          if (typeof handler.command !== 'string' || !handler.command.trim()) continue;
          hooks[event].push({...handler, matcher: str(group.matcher), scope, source: file});
        }
      }
    }
  }
  if (disabled) for (const event of EVENTS) hooks[event] = [];
  return {hooks, diagnostics, disabled};
}

export function toClaudeTool(name) {
  const builtins = {
    shell:'Bash', bash:'Bash', patch:'Edit', edit:'Edit', write:'Write',
    read:'Read', glob:'Glob', grep:'Grep', list:'LS', task:'Task',
    subagent:'Task', webfetch:'WebFetch', websearch:'WebSearch',
    todowrite:'TodoWrite', skill:'Skill', question:'Question',
  };
  if (builtins[name]) return builtins[name];
  if (name.startsWith('mcp__')) return name;
  const match = name.match(/^([A-Za-z0-9:-]+)_(.+)$/);
  return match ? 'mcp__' + match[1] + '__' + match[2] : name;
}

export function matcherHits(matcher, value = '') {
  if (!matcher || matcher === '*') return true;
  if (/^[\p{L}\p{N}_\-,| ]+$/u.test(matcher)) {
    return matcher.split(/[|,]/).some((part) => part.trim() === value);
  }
  try { return new RegExp(matcher).test(value); } catch { return false; }
}

export function conditionHits(condition, tool, input) {
  if (!condition) return true;
  const parsed = String(condition).match(/^([A-Za-z]+)\((.*)\)$/s);
  if (!parsed || parsed[1] !== tool) return false;
  const value = tool === 'Bash' ? input?.command :
    ['Read', 'Write', 'Edit'].includes(tool) ? input?.file_path ?? input?.filePath ?? input?.path : undefined;
  if (typeof value !== 'string') return false;
  const pattern = parsed[2].replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  try { return new RegExp('^' + pattern + '$', 's').test(value); } catch { return false; }
}

function interpret(event, code, stdout, stderr, failed) {
  let json;
  try { const data = JSON.parse(stdout.trim()); if (isObject(data)) json = data; } catch {}
  const special = object(json?.hookSpecificOutput);
  const rawDecision = event === 'PermissionRequest' ? special.decision?.behavior ?? special.permissionDecision ?? json?.decision :
    special.permissionDecision ?? json?.decision;
  const decision = rawDecision === 'approve' ? 'allow' : rawDecision === 'block' ? 'deny' : rawDecision;
  const canBlock = ['PreToolUse', 'UserPromptSubmit', 'PreCompact', 'PermissionRequest'].includes(event);
  const blocked = canBlock && (code === 2 || decision === 'deny' || json?.continue === false);
  const context = special.additionalContext ?? json?.additionalContext ??
    ((event === 'SessionStart' || event === 'UserPromptSubmit') && !json && code === 0 ? stdout.trim() : undefined);
  return {
    code, blocked, decision: blocked ? 'deny' : decision,
    reason: str(special.permissionDecisionReason ?? special.decision?.message ?? json?.reason) || stderr.trim() || 'Hook rejected action',
    context: typeof context === 'string' ? context : undefined,
    updatedInput: isObject(special.updatedInput) ? special.updatedInput : undefined,
    updatedToolOutput: special.updatedToolOutput, json, failed,
  };
}

function expandVariables(text, env) {
  return String(text).replaceAll('\u0024{CLAUDE_PROJECT_DIR}', env.CLAUDE_PROJECT_DIR)
    .replaceAll('\u0024CLAUDE_PROJECT_DIR', env.CLAUDE_PROJECT_DIR);
}

export async function runCommand(hook, payload, {project = process.cwd(), env = process.env, warn = console.warn} = {}) {
  const vars = {...env, CLAUDE_PROJECT_DIR: project};
  const timeout = Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout * 1000 : 30000;
  const args = Array.isArray(hook.args) ? hook.args.map((arg) => expandVariables(arg, vars)) : [];
  const command = expandVariables(hook.command, vars);
  return new Promise((resolve) => {
    let child, stdout = '', stderr = '', failed = false, timedOut = false, settled = false, timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = interpret(payload.hook_event_name, code, stdout, stderr, failed);
      result.timedOut = timedOut;
      if (timedOut || failed) {
        result.reason = timedOut ? 'Hook timed out' : (stderr.trim() || 'Hook execution failed');
        if ((timedOut && payload.hook_event_name === 'PreToolUse') ||
            (hook.onFailure === 'block' && ['PreToolUse','UserPromptSubmit','PreCompact','PermissionRequest'].includes(payload.hook_event_name))) {
          result.blocked = true; result.decision = 'deny';
        }
      }
      resolve(result);
    };
    try {
      child = spawn(command, args, {cwd:project, env:vars, shell:args.length===0, windowsHide:true, stdio:['pipe','pipe','pipe']});
    } catch (error) { stderr = String(error); failed = true; finish(1); return; }
    const collect = (kind, data) => {
      if (kind === 'out') stdout += data.toString(); else stderr += data.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BYTES) {
        failed = true; stderr += '\nHook output exceeded 1 MiB'; child.kill();
      }
    };
    child.stdout.on('data', (data) => collect('out', data));
    child.stderr.on('data', (data) => collect('err', data));
    child.on('error', (error) => { stderr += String(error); failed = true; finish(1); });
    child.on('close', (code) => { if (code !== 0) failed = true; finish(code ?? 1); });
    timer = setTimeout(() => { timedOut = true; failed = true; child.kill(); }, timeout);
    timer.unref?.();
    child.stdin.on('error', (error) => warn('[claude-hooks-compat] stdin: ' + error.message));
    child.stdin.end(JSON.stringify(payload));
  });
}

const contexts = (results) => results.flatMap((r) => r.context?.trim() ? [r.context.trim()] : []);
const firstBlock = (results) => results.find((r) => r.blocked);

export function createBridge({project = process.cwd(), home = os.homedir(), scopes, env = process.env, warn = console.warn} = {}) {
  project = path.resolve(project);
  const {hooks, diagnostics, disabled} = loadSettings({home, project, scopes, warn});
  const starts = new Map(), pending = new Map();
  const run = async (name, sid, extra = {}, onResult) => {
    const payload = {hook_event_name:name, session_id:sid ?? '', cwd:project, permission_mode:'default', ...extra};
    const results = [];
    for (const hook of hooks[name] ?? []) {
      const matcher = str(payload.tool_name ?? payload.source ?? payload.trigger ?? payload.reason);
      if (!['UserPromptSubmit','Stop'].includes(name) && !matcherHits(hook.matcher, matcher)) continue;
      if (!conditionHits(hook.if, payload.tool_name, payload.tool_input)) continue;
      if (hook.async === true) {
        void runCommand(hook, structuredClone(payload), {project, env, warn}).catch(warn);
        continue;
      }
      const result = await runCommand(hook, payload, {project, env, warn});
      results.push(result);
      onResult?.(result, payload);
      if (result.blocked) break;
    }
    return results;
  };
  const start = async (sid, source = 'startup') => {
    if (!starts.has(sid)) {
      starts.set(sid, run('SessionStart', sid, {source}).then((results) => {
        pending.set(sid, contexts(results));
      }));
    }
    await starts.get(sid);
  };
  const drain = (sid) => { const result = pending.get(sid) ?? []; pending.delete(sid); return result; };
  const end = async (sid) => { await run('SessionEnd', sid, {reason:'clear'}); starts.delete(sid); pending.delete(sid); };
  return {run, start, drain, end, diagnostics, disabled};
}

function appendContext(event, extra) {
  if (!extra.length) return;
  const result = object(event.result);
  if (Array.isArray(result.content)) {
    event.result = {...result, content:[...result.content, ...extra.map((text) => ({type:'text', text}))]};
  } else {
    event.result = {...result, content:[str(result.content), ...extra].filter(Boolean).join('\n\n')};
  }
}

export async function setupV2(ctx) {
  const opts = object(ctx.options);
  const project = opts.project ?? ctx.location?.project?.directory ?? ctx.location?.directory ?? process.cwd();
  const bridge = createBridge({project, home:opts.home, scopes:opts.scopes, warn:opts.warn});
  const abort = new AbortController();
  const disposers = [];
  const add = async (api, event, fn) => {
    if (typeof api?.hook === 'function') disposers.push(await api.hook(event, fn));
  };
  await add(ctx.session, 'context', async (event) => {
    const id = sessionId(event);
    await bridge.start(id);
    const extra = bridge.drain(id);
    if (extra.length) {
      event.system ??= [];
      event.system.push(...extra.map((text) => ({type:'text', text})));
    }
  });
  await add(ctx.session, 'prompt', async (event) => {
    const prompt = object(event.prompt);
    const results = await bridge.run('UserPromptSubmit', sessionId(event), {prompt:str(prompt.text)});
    const deny = firstBlock(results);
    if (deny) throw new Error('UserPromptSubmit hook blocked prompt: ' + deny.reason);
    const extra = contexts(results);
    if (extra.length) prompt.text = [str(prompt.text), ...extra].join('\n\n');
    event.prompt = prompt;
  });
  await add(ctx.session, 'compaction', async (event) => {
    const trigger = event.trigger === 'manual' ? 'manual' : 'auto';
    const results = await bridge.run('PreCompact', sessionId(event), {trigger});
    const deny = firstBlock(results);
    if (deny) throw new Error('PreCompact hook blocked compaction: ' + deny.reason);
    event.system ??= [];
    event.system.push(...contexts(results).map((text) => ({type:'text', text})));
  });
  await add(ctx.tool, 'execute.before', async (event) => {
    const tool = toClaudeTool(str(event.tool));
    const input = object(event.input);
    const results = await bridge.run('PreToolUse', sessionId(event),
      {tool_name:tool, tool_input:input, tool_use_id:event.id ?? event.callID},
      (result, payload) => {
        if (!result.blocked && result.updatedInput) {
          Object.assign(input, result.updatedInput);
          payload.tool_input = input;
        }
      });
    const deny = firstBlock(results);
    if (deny) throw new Error('PreToolUse hook blocked ' + tool + ': ' + deny.reason);
    event.input = input;
  });
  await add(ctx.tool, 'execute.after', async (event) => {
    const tool = toClaudeTool(str(event.tool));
    const failed = event.status === 'error';
    const results = await bridge.run(failed ? 'PostToolUseFailure' : 'PostToolUse', sessionId(event), {
      tool_name:tool, tool_input:event.input, tool_use_id:event.id ?? event.callID,
      ...(failed ? {error:str(event.error?.message)} : {tool_response:event.result?.content ?? event.result}),
    });
    if (!failed) {
      for (const result of results) {
        if (result.updatedToolOutput !== undefined) {
          event.result = {...object(event.result), content:typeof result.updatedToolOutput === 'string'
            ? result.updatedToolOutput : JSON.stringify(result.updatedToolOutput)};
        }
      }
      appendContext(event, contexts(results));
    }
  });
  await add(ctx.permission, 'evaluate', async (event) => {
    const tool = toClaudeTool(str(event.metadata?.toolName ?? event.action ?? event.permission));
    const results = await bridge.run('PermissionRequest', sessionId(event), {
      tool_name:tool, tool_input:{action:event.action, resources:event.resources, ...object(event.metadata)},
    });
    if (results.some((r) => r.blocked || r.decision === 'deny')) {
      event.effect = 'deny';
      event.message = results.find((r) => r.blocked || r.decision === 'deny')?.reason;
    } else if (results.some((r) => r.decision === 'allow')) event.effect = 'allow';
  });
  if (ctx.event?.subscribe) {
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({signal:abort.signal})) {
          const type = str(raw.type);
          const props = {...object(raw.properties), ...object(raw.data)};
          const id = sessionId(props);
          if (type === 'session.created') await bridge.start(id);
          else if (type === 'session.deleted' || type === 'session.removed') await bridge.end(id);
          else if (type === 'session.idle') await bridge.run('Stop', id, {stop_hook_active:false});
        }
      } catch (error) { if (!abort.signal.aborted) console.warn('[claude-hooks-compat] event stream:', error); }
    })();
  }
  return async () => { abort.abort(); for (const item of disposers) await item?.dispose?.(); };
}

export async function setupV1(input = {}) {
  const opts = object(input.options);
  const bridge = createBridge({
    project:opts.project ?? input.worktree ?? input.directory ?? process.cwd(),
    home:opts.home, scopes:opts.scopes, warn:opts.warn,
  });
  const pending = [];
  return {
    event:async ({event}) => {
      const id = sessionId(object(event.properties));
      if (event.type === 'session.created') { await bridge.start(id); pending.push(...bridge.drain(id)); }
      if (event.type === 'session.deleted') await bridge.end(id);
      if (event.type === 'session.idle') await bridge.run('Stop', id, {stop_hook_active:false});
    },
    'chat.message':async (input, output) => {
      const id = str(input.sessionID);
      await bridge.start(id); pending.push(...bridge.drain(id));
      const parts = Array.isArray(output.parts) ? output.parts : [];
      const prompt = parts.filter((part) => part?.type === 'text').map((part) => str(part.text)).join('\n');
      const results = await bridge.run('UserPromptSubmit', id, {prompt});
      const deny = firstBlock(results);
      if (deny) throw new Error('UserPromptSubmit hook blocked prompt: ' + deny.reason);
      const extra = contexts(results);
      if (extra.length) output.parts = [...parts, {type:'text', text:extra.join('\n\n')}];
    },
    'tool.execute.before':async (input, output) => {
      const tool = toClaudeTool(str(input.tool));
      const results = await bridge.run('PreToolUse', input.sessionID, {
        tool_name:tool, tool_input:output.args, tool_use_id:input.callID,
      }, (r) => {if (!r.blocked && r.updatedInput) Object.assign(output.args, r.updatedInput);});
      const deny = firstBlock(results);
      if (deny) throw new Error('PreToolUse hook blocked ' + tool + ': ' + deny.reason);
    },
    'tool.execute.after':async (input, output) => {
      const tool = toClaudeTool(str(input.tool));
      const failure = Boolean(output.metadata?.error || /^error[: ]/i.test(str(output.title)));
      const results = await bridge.run(failure ? 'PostToolUseFailure' : 'PostToolUse', input.sessionID, {
        tool_name:tool, tool_input:input.args, tool_use_id:input.callID,
        ...(failure ? {error:output.output} : {tool_response:output.output}),
      });
      if (!failure) {
        for (const result of results) if (result.updatedToolOutput !== undefined)
          output.output = typeof result.updatedToolOutput === 'string'
            ? result.updatedToolOutput : JSON.stringify(result.updatedToolOutput);
        if (contexts(results).length) output.output += '\n\n' + contexts(results).join('\n\n');
      }
    },
    'permission.ask':async (input, output) => {
      const tool = toClaudeTool(str(input.permission ?? input.type));
      const results = await bridge.run('PermissionRequest', input.sessionID, {
        tool_name:tool, tool_input:{patterns:input.patterns},
      });
      if (results.some((r) => r.blocked || r.decision === 'deny')) output.status = 'deny';
      else if (results.some((r) => r.decision === 'allow')) output.status = 'allow';
    },
    'experimental.session.compacting':async (input, output) => {
      const results = await bridge.run('PreCompact', input.sessionID, {trigger:'auto'});
      const deny = firstBlock(results);
      if (deny) throw new Error('PreCompact hook blocked compaction: ' + deny.reason);
      output.context.push(...contexts(results));
    },
    'experimental.chat.system.transform':async (_input, output) => { output.system.push(...pending.splice(0)); },
  };
}

export default {id:PLUGIN_ID, setup:setupV2, server:setupV1};
