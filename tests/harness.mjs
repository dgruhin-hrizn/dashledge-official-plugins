// Runs a first-party plugin's connector or view script in Node, the way Dashledge does:
// a fresh context with the connector globals, a fetch that reaches only the manifest's
// connector hosts and the placement's connections, and a clock the test moves by hand.
// Replies come from recorded server responses, never the network.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const root = new URL('..', import.meta.url).pathname;
export const pluginDir = name => join(root, 'plugins', name);
export const manifest = name => JSON.parse(readFileSync(join(pluginDir(name), 'widget.json'), 'utf8'));
export const sample = (name, file) => JSON.parse(readFileSync(join(root, 'tests', name, file), 'utf8'));

// A clock and timers the test controls.
function fakeClock(start) {
  let now = start, seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => { const id = ++seq; timers.set(id, {fn, at: now + Math.max(0, ms || 0), every: repeat ? Math.max(1, ms || 0) : 0}); return id; };
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: id => timers.delete(id),
    // Run every timer due within `ms`, in time order, letting promises settle between them.
    async advance(ms, settle) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

// A Response-like object for a recorded reply: {status?, json?, text?, headers?}.
function response(reply) {
  const status = reply.status ?? 200;
  const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
  const headers = new Map(Object.entries(reply.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300, status,
    headers: {get: name => headers.get(String(name).toLowerCase()) ?? null},
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

/**
 * Load plugins/<name>/<connector entry> with:
 * - `respond(url, init)`: returns a recorded reply, or throws to fail the request;
 * - `connections`: [{address, name, type}] for plugins that use them;
 * - `storage`: an object shared across loads, to test a restart.
 */
export function loadConnector(name, {respond = () => ({status: 404}), connections = [], storage = {}, start = Date.UTC(2026, 10, 27, 19)} = {}) {
  const m = manifest(name);
  const hosts = m.connector?.hosts || [];
  const allowed = url => hosts.some(h => url === h || url.startsWith(h + '/')) || connections.some(c => url.startsWith(c.address));
  const clock = fakeClock(start);
  const emitted = [], requests = [], logs = [], commands = new Map();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const log = level => (...args) => logs.push({level, text: args.map(String).join(' ')});
  const context = vm.createContext({
    dashledge: {
      connection: connections[0] || null,
      connections,
      onCommand: (command, handler) => commands.set(command, handler),
      emit: data => emitted.push(JSON.parse(JSON.stringify(data))),
      storage: {
        get: key => (key in storage ? JSON.parse(storage[key]) : undefined),
        set: (key, value) => { storage[key] = JSON.stringify(value); },
      },
    },
    async fetch(url, init = {}) {
      url = String(url);
      requests.push({url, method: init.method || 'GET', body: init.body});
      if (!allowed(url)) throw new Error('Dashledge refuses ' + url + ': not a connector host or the connection');
      return response(await respond(url, init));
    },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clear, clearInterval: clock.clear,
    queueMicrotask,
    console: {log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug')},
    Date: FakeDate,
  });
  vm.runInContext(readFileSync(join(pluginDir(name), m.connector.entry), 'utf8'), context, {filename: m.connector.entry});

  return {
    emitted, requests, logs, storage, clock,
    last: () => emitted[emitted.length - 1],
    settle,
    advance: ms => clock.advance(ms, settle),
    // Send a command as a view would, and let the work it starts finish.
    async command(command, args) {
      const handler = commands.get(command);
      if (!handler) throw new Error('The connector has no ' + command + ' command');
      if (!(m.connector.commands || []).includes(command)) throw new Error(command + ' is not in connector.commands');
      const answer = await handler(args);
      return JSON.parse(JSON.stringify(answer ?? null));
    },
  };
}

// Run a classic view script, such as a model.js that sets a global, and return its globals.
export function loadViewScript(name, file) {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(pluginDir(name), file), 'utf8'), context, {filename: file});
  return context;
}
