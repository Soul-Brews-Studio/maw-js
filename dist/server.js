// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// src/config.ts
import { readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
function loadConfig() {
  if (cached)
    return cached;
  const configPath = join2(import.meta.dir, "../maw.config.json");
  try {
    const raw2 = JSON.parse(readFileSync(configPath, "utf-8"));
    cached = { ...DEFAULTS, ...raw2 };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}
function resetConfig() {
  cached = null;
}
function saveConfig(update) {
  const configPath = join2(import.meta.dir, "../maw.config.json");
  const current = loadConfig();
  const merged = { ...current, ...update };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + `
`, "utf-8");
  resetConfig();
  return loadConfig();
}
function configForDisplay() {
  const config = loadConfig();
  const envMasked = {};
  for (const [k, v] of Object.entries(config.env)) {
    if (v.length <= 4) {
      envMasked[k] = "\u2022".repeat(v.length);
    } else {
      envMasked[k] = v.slice(0, 3) + "\u2022".repeat(Math.min(v.length - 3, 20));
    }
  }
  return { ...config, env: {}, envMasked };
}
function matchGlob(pattern, name) {
  if (pattern === name)
    return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1)))
    return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)))
    return true;
  return false;
}
function buildCommand(agentName) {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";
  for (const [pattern, command] of Object.entries(config.commands)) {
    if (pattern === "default")
      continue;
    if (matchGlob(pattern, agentName)) {
      cmd = command;
      break;
    }
  }
  const prefix = 'command -v direnv >/dev/null && direnv allow . && eval "$(direnv export zsh)"; unset CLAUDECODE 2>/dev/null;';
  if (cmd.includes("--continue")) {
    const fallback = cmd.replace(/\s*--continue\b/, "");
    return `${prefix} ${cmd} || ${prefix} ${fallback}`;
  }
  return `${prefix} ${cmd}`;
}
var DEFAULTS, cached = null;
var init_config = __esm(() => {
  DEFAULTS = {
    host: "local",
    port: 3456,
    ghqRoot: "/home/nat/Code/github.com",
    oracleUrl: "http://localhost:47779",
    env: {},
    commands: { default: "claude" },
    sessions: {}
  };
});

// src/tmux.ts
var exports_tmux = {};
__export(exports_tmux, {
  tmux: () => tmux,
  Tmux: () => Tmux
});
function q(s) {
  const str = String(s);
  if (/^[a-zA-Z0-9_.:\-\/]+$/.test(str))
    return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

class Tmux {
  host;
  constructor(host) {
    this.host = host;
  }
  async run(subcommand, ...args) {
    const cmd = `tmux ${subcommand} ${args.map(q).join(" ")} 2>/dev/null`;
    return ssh(cmd, this.host);
  }
  async tryRun(subcommand, ...args) {
    return this.run(subcommand, ...args).catch(() => "");
  }
  async listSessions() {
    const raw2 = await this.run("list-sessions", "-F", "#{session_name}");
    const sessions = [];
    for (const s of raw2.split(`
`).filter(Boolean)) {
      const windows = await this.listWindows(s);
      sessions.push({ name: s, windows });
    }
    return sessions;
  }
  async listAll() {
    const raw2 = await this.run("list-windows", "-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}");
    const map = new Map;
    for (const line of raw2.split(`
`).filter(Boolean)) {
      const [session, idx, name, active, cwd] = line.split("|||");
      if (!map.has(session))
        map.set(session, []);
      map.get(session).push({ index: +idx, name, active: active === "1", cwd: cwd || undefined });
    }
    return [...map.entries()].map(([name, windows]) => ({ name, windows }));
  }
  async hasSession(name) {
    try {
      await this.run("has-session", "-t", name);
      return true;
    } catch {
      return false;
    }
  }
  async newSession(name, opts = {}) {
    const args = [];
    if (opts.detached !== false)
      args.push("-d");
    args.push("-s", name);
    if (opts.window)
      args.push("-n", opts.window);
    if (opts.cwd)
      args.push("-c", opts.cwd);
    await this.run("new-session", ...args);
  }
  async newGroupedSession(parent, name, opts) {
    await this.run("new-session", "-d", "-t", parent, "-s", name, "-x", opts.cols, "-y", opts.rows);
    if (opts.window)
      await this.selectWindow(`${name}:${opts.window}`);
  }
  async killSession(name) {
    await this.tryRun("kill-session", "-t", name);
  }
  async listWindows(session) {
    const raw2 = await this.run("list-windows", "-t", session, "-F", "#{window_index}:#{window_name}:#{window_active}");
    return raw2.split(`
`).filter(Boolean).map((w) => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
  }
  async newWindow(session, name, opts = {}) {
    const args = ["-t", session, "-n", name];
    if (opts.cwd)
      args.push("-c", opts.cwd);
    await this.run("new-window", ...args);
  }
  async selectWindow(target) {
    await this.tryRun("select-window", "-t", target);
  }
  async killWindow(target) {
    await this.tryRun("kill-window", "-t", target);
  }
  async getPaneCommand(target) {
    const raw2 = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}");
    return raw2.split(`
`)[0] || "";
  }
  async getPaneCommands(targets) {
    const result = {};
    await Promise.allSettled(targets.map(async (t) => {
      try {
        result[t] = await this.getPaneCommand(t);
      } catch {}
    }));
    return result;
  }
  async capture(target, lines = 80) {
    if (lines > 50) {
      return this.run("capture-pane", "-t", target, "-e", "-p", "-S", -lines);
    }
    const cmd = `tmux capture-pane -t ${q(target)} -e -p 2>/dev/null | tail -${lines}`;
    return ssh(cmd, this.host);
  }
  async resizePane(target, cols, rows) {
    const c = Math.max(1, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(200, Math.floor(rows)));
    await this.tryRun("resize-pane", "-t", target, "-x", c, "-y", r);
  }
  async splitWindow(target) {
    await this.run("split-window", "-t", target);
  }
  async selectPane(target, opts = {}) {
    const args = ["-t", target];
    if (opts.title)
      args.push("-T", opts.title);
    await this.run("select-pane", ...args);
  }
  async selectLayout(target, layout) {
    await this.run("select-layout", "-t", target, layout);
  }
  async sendKeys(target, ...keys) {
    await this.run("send-keys", "-t", target, ...keys);
  }
  async sendKeysLiteral(target, text) {
    await this.run("send-keys", "-t", target, "-l", text);
  }
  async loadBuffer(text) {
    const escaped = text.replace(/'/g, "'\\''");
    const cmd = `printf '%s' '${escaped}' | tmux load-buffer -`;
    await ssh(cmd, this.host);
  }
  async pasteBuffer(target) {
    await this.run("paste-buffer", "-t", target);
  }
  async sendText(target, text) {
    if (text.includes(`
`) || text.length > 500) {
      await this.loadBuffer(text);
      await this.pasteBuffer(target);
      await new Promise((r) => setTimeout(r, 150));
      await this.sendKeys(target, "Enter");
    } else {
      await this.run("send-keys", "-t", target, "--", text, "Enter");
    }
  }
  async setEnvironment(session, key, value) {
    await this.run("set-environment", "-t", session, key, value);
  }
  async setOption(target, option, value) {
    await this.tryRun("set-option", "-t", target, option, value);
  }
  async set(target, option, value) {
    await this.tryRun("set", "-t", target, option, value);
  }
}
var tmux;
var init_tmux = __esm(() => {
  init_ssh();
  tmux = new Tmux;
});

// src/ssh.ts
async function ssh(cmd, host = DEFAULT_HOST) {
  const local = host === "local" || host === "localhost" || IS_LOCAL;
  const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.trim() || `exit ${code}`);
  }
  return text.trim();
}
async function listSessions(host) {
  let raw2;
  try {
    raw2 = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null", host);
  } catch {
    return [];
  }
  const sessions = [];
  for (const s of raw2.split(`
`).filter(Boolean)) {
    const winRaw = await ssh(`tmux list-windows -t '${s}' -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null`, host);
    const windows = winRaw.split(`
`).filter(Boolean).map((w) => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
    sessions.push({ name: s, windows });
  }
  return sessions;
}
async function capture(target, lines = 80, host) {
  if (lines > 50) {
    return ssh(`tmux capture-pane -t '${target}' -e -p -S -${lines} 2>/dev/null`, host);
  }
  return ssh(`tmux capture-pane -t '${target}' -e -p 2>/dev/null | tail -${lines}`, host);
}
async function selectWindow(target, host) {
  await ssh(`tmux select-window -t '${target}' 2>/dev/null`, host);
}
async function getPaneCommand(target, host) {
  const { Tmux: Tmux2 } = await Promise.resolve().then(() => (init_tmux(), exports_tmux));
  const t = new Tmux2(host);
  return t.getPaneCommand(target);
}
async function sendKeys(target, text, host) {
  const { Tmux: Tmux2 } = await Promise.resolve().then(() => (init_tmux(), exports_tmux));
  const t = new Tmux2(host);
  const SPECIAL_KEYS = {
    "\x1B": "Escape",
    "\x1B[A": "Up",
    "\x1B[B": "Down",
    "\x1B[C": "Right",
    "\x1B[D": "Left",
    "\r": "Enter",
    "\n": "Enter",
    "\b": "BSpace",
    "\x15": "C-u"
  };
  if (SPECIAL_KEYS[text]) {
    await t.sendKeys(target, SPECIAL_KEYS[text]);
    return;
  }
  const endsWithEnter = text.endsWith("\r") || text.endsWith(`
`);
  const body = endsWithEnter ? text.slice(0, -1) : text;
  if (!body) {
    await t.sendKeys(target, "Enter");
    return;
  }
  if (body.startsWith("/")) {
    for (const ch of body) {
      await t.sendKeysLiteral(target, ch);
    }
    await t.sendKeys(target, "Enter");
  } else {
    await t.sendText(target, body);
  }
}
var DEFAULT_HOST, IS_LOCAL;
var init_ssh = __esm(() => {
  init_config();
  DEFAULT_HOST = process.env.MAW_HOST || loadConfig().host || "white.local";
  IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";
});

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || undefined;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/body.js
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
};
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== undefined) {
    if (Array.isArray(form[key])) {
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
};
var handleParsingNestedValues = (form, key, value) => {
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match, index) => {
    const mark = `@${index}`;
    groups.push([mark, match]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1;i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1;j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match[1], new RegExp(`^${match[2]}(?=/${next})`)] : [label, match[1], new RegExp(`^${match[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decoder(match);
      } catch {
        return match;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (;i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? undefined : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? undefined : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? undefined : nextKeyIndex : valueIndex);
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? undefined : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = (str) => tryDecode(str, decodeURIComponent_);
var HonoRequest = class {
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== undefined) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? undefined;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return this.bodyCache.parsedBody ??= await parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw[key]();
  };
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  text() {
    return this.#cachedBody("text");
  }
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  blob() {
    return this.#cachedBody("blob");
  }
  formData() {
    return this.#cachedBody("formData");
  }
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  get url() {
    return this.raw.url;
  }
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  env = {};
  #var;
  finalized = false;
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers
    });
  }
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  setLayout = (layout) => this.#layout = layout;
  getLayout = () => this.#layout;
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers;
    if (value === undefined) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map;
    this.#var.set(key, value);
  };
  get = (key) => {
    return this.#var ? this.#var.get(key) : undefined;
  };
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers;
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = (...args) => this.#newResponse(...args);
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  json = (object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  redirect = (location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler);
    });
    return this;
  }
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = undefined;
      try {
        executionContext = c.executionCtx;
      } catch {}
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { basePath: this._basePath, path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, undefined, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = (method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  };
  this.match = match2;
  return match2(method, path);
}

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class _Node {
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== undefined) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node;
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node;
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node;
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0;; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1;i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1;j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== undefined) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== undefined) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(path === "*" ? "" : `^${path.replace(/\/\*$|([.\\+*[^\]$()])/g, (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)")}$`);
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie;
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map((route) => [!/\*|\/:/.test(route[0]), ...route]).sort(([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length);
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length;i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (;paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length;i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length;j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length;k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return;
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach((p) => re.test(p) && routes[m][p].push([handler, paramCount]));
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length;i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = undefined;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]]));
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/reg-exp-router/prepared-router.js
var PreparedRegExpRouter = class {
  name = "PreparedRegExpRouter";
  #matchers;
  #relocateMap;
  constructor(matchers, relocateMap) {
    this.#matchers = matchers;
    this.#relocateMap = relocateMap;
  }
  #addWildcard(method, handlerData) {
    const matcher = this.#matchers[method];
    matcher[1].forEach((list) => list && list.push(handlerData));
    Object.values(matcher[2]).forEach((list) => list[0].push(handlerData));
  }
  #addPath(method, path, handler, indexes, map) {
    const matcher = this.#matchers[method];
    if (!map) {
      matcher[2][path][0].push([handler, {}]);
    } else {
      indexes.forEach((index) => {
        if (typeof index === "number") {
          matcher[1][index].push([handler, map]);
        } else {
          matcher[2][index || path][0].push([handler, map]);
        }
      });
    }
  }
  add(method, path, handler) {
    if (!this.#matchers[method]) {
      const all = this.#matchers[METHOD_NAME_ALL];
      const staticMap = {};
      for (const key in all[2]) {
        staticMap[key] = [all[2][key][0].slice(), emptyParam];
      }
      this.#matchers[method] = [
        all[0],
        all[1].map((list) => Array.isArray(list) ? list.slice() : 0),
        staticMap
      ];
    }
    if (path === "/*" || path === "*") {
      const handlerData = [handler, {}];
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addWildcard(m, handlerData);
        }
      } else {
        this.#addWildcard(method, handlerData);
      }
      return;
    }
    const data = this.#relocateMap[path];
    if (!data) {
      throw new Error(`Path ${path} is not registered`);
    }
    for (const [indexes, map] of data) {
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addPath(m, path, handler, indexes, map);
        }
      } else {
        this.#addPath(method, path, handler, indexes, map);
      }
    }
  }
  buildAllMatchers() {
    return this.#matchers;
  }
  match = match;
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (;i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length;i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = undefined;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = (children) => {
  for (const _ in children) {
    return true;
  }
  return false;
};
var Node2 = class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length;i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2;
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length;i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== undefined) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length;i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0;i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length;j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length;k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0;p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2;
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length;i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter, new TrieRouter]
    });
  }
};

// node_modules/hono/dist/middleware/cors/index.js
var cors = (options) => {
  const defaults = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    allowHeaders: [],
    exposeHeaders: []
  };
  const opts = {
    ...defaults,
    ...options
  };
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") {
        return () => optsOrigin;
      } else {
        return (origin) => optsOrigin === origin ? origin : null;
      }
    } else if (typeof optsOrigin === "function") {
      return optsOrigin;
    } else {
      return (origin) => optsOrigin.includes(origin) ? origin : null;
    }
  })(opts.origin);
  const findAllowMethods = ((optsAllowMethods) => {
    if (typeof optsAllowMethods === "function") {
      return optsAllowMethods;
    } else if (Array.isArray(optsAllowMethods)) {
      return () => optsAllowMethods;
    } else {
      return () => [];
    }
  })(opts.allowMethods);
  return async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) {
      set("Access-Control-Allow-Origin", allowOrigin);
    }
    if (opts.credentials) {
      set("Access-Control-Allow-Credentials", "true");
    }
    if (opts.exposeHeaders?.length) {
      set("Access-Control-Expose-Headers", opts.exposeHeaders.join(","));
    }
    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*") {
        set("Vary", "Origin");
      }
      if (opts.maxAge != null) {
        set("Access-Control-Max-Age", opts.maxAge.toString());
      }
      const allowMethods = await findAllowMethods(c.req.header("origin") || "", c);
      if (allowMethods.length) {
        set("Access-Control-Allow-Methods", allowMethods.join(","));
      }
      let headers = opts.allowHeaders;
      if (!headers?.length) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) {
          headers = requestHeaders.split(/\s*,\s*/);
        }
      }
      if (headers?.length) {
        set("Access-Control-Allow-Headers", headers.join(","));
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content"
      });
    }
    await next();
    if (opts.origin !== "*") {
      c.header("Vary", "Origin", { append: true });
    }
  };
};

// node_modules/hono/dist/adapter/bun/serve-static.js
import { stat } from "fs/promises";
import { join } from "path";

// node_modules/hono/dist/utils/compress.js
var COMPRESSIBLE_CONTENT_TYPE_REGEX = /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i;

// node_modules/hono/dist/utils/mime.js
var getMimeType = (filename, mimes = baseMimes) => {
  const regexp = /\.([a-zA-Z0-9]+?)$/;
  const match2 = filename.match(regexp);
  if (!match2) {
    return;
  }
  let mimeType = mimes[match2[1]];
  if (mimeType && mimeType.startsWith("text")) {
    mimeType += "; charset=utf-8";
  }
  return mimeType;
};
var _baseMimes = {
  aac: "audio/aac",
  avi: "video/x-msvideo",
  avif: "image/avif",
  av1: "video/av1",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  eot: "application/vnd.ms-fontobject",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsonld: "application/ld+json",
  map: "application/json",
  mid: "audio/x-midi",
  midi: "audio/x-midi",
  mjs: "text/javascript",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  oga: "audio/ogg",
  ogv: "video/ogg",
  ogx: "application/ogg",
  opus: "audio/opus",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
  webm: "video/webm",
  weba: "audio/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml",
  xml: "application/xml",
  zip: "application/zip",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  gltf: "model/gltf+json",
  glb: "model/gltf-binary"
};
var baseMimes = _baseMimes;

// node_modules/hono/dist/middleware/serve-static/path.js
var defaultJoin = (...paths) => {
  let result = paths.filter((p) => p !== "").join("/");
  result = result.replace(/(?<=\/)\/+/g, "");
  const segments = result.split("/");
  const resolved = [];
  for (const segment of segments) {
    if (segment === ".." && resolved.length > 0 && resolved.at(-1) !== "..") {
      resolved.pop();
    } else if (segment !== ".") {
      resolved.push(segment);
    }
  }
  return resolved.join("/") || ".";
};

// node_modules/hono/dist/middleware/serve-static/index.js
var ENCODINGS = {
  br: ".br",
  zstd: ".zst",
  gzip: ".gz"
};
var ENCODINGS_ORDERED_KEYS = Object.keys(ENCODINGS);
var DEFAULT_DOCUMENT = "index.html";
var serveStatic = (options) => {
  const root = options.root ?? "./";
  const optionPath = options.path;
  const join = options.join ?? defaultJoin;
  return async (c, next) => {
    if (c.finalized) {
      return next();
    }
    let filename;
    if (options.path) {
      filename = options.path;
    } else {
      try {
        filename = tryDecodeURI(c.req.path);
        if (/(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(filename)) {
          throw new Error;
        }
      } catch {
        await options.onNotFound?.(c.req.path, c);
        return next();
      }
    }
    let path = join(root, !optionPath && options.rewriteRequestPath ? options.rewriteRequestPath(filename) : filename);
    if (options.isDir && await options.isDir(path)) {
      path = join(path, DEFAULT_DOCUMENT);
    }
    const getContent = options.getContent;
    let content = await getContent(path, c);
    if (content instanceof Response) {
      return c.newResponse(content.body, content);
    }
    if (content) {
      const mimeType = options.mimes && getMimeType(path, options.mimes) || getMimeType(path);
      c.header("Content-Type", mimeType || "application/octet-stream");
      if (options.precompressed && (!mimeType || COMPRESSIBLE_CONTENT_TYPE_REGEX.test(mimeType))) {
        const acceptEncodingSet = new Set(c.req.header("Accept-Encoding")?.split(",").map((encoding) => encoding.trim()));
        for (const encoding of ENCODINGS_ORDERED_KEYS) {
          if (!acceptEncodingSet.has(encoding)) {
            continue;
          }
          const compressedContent = await getContent(path + ENCODINGS[encoding], c);
          if (compressedContent) {
            content = compressedContent;
            c.header("Content-Encoding", encoding);
            c.header("Vary", "Accept-Encoding", { append: true });
            break;
          }
        }
      }
      await options.onFound?.(path, c);
      return c.body(content);
    }
    await options.onNotFound?.(path, c);
    await next();
    return;
  };
};

// node_modules/hono/dist/adapter/bun/serve-static.js
var serveStatic2 = (options) => {
  return async function serveStatic22(c, next) {
    const getContent = async (path) => {
      const file = Bun.file(path);
      return await file.exists() ? file : null;
    };
    const isDir = async (path) => {
      let isDir2;
      try {
        const stats = await stat(path);
        isDir2 = stats.isDirectory();
      } catch {}
      return isDir2;
    };
    return serveStatic({
      ...options,
      getContent,
      join,
      isDir
    })(c, next);
  };
};

// node_modules/hono/dist/helper/ssg/middleware.js
var X_HONO_DISABLE_SSG_HEADER_KEY = "x-hono-disable-ssg";
var SSG_DISABLED_RESPONSE = (() => {
  try {
    return new Response("SSG is disabled", {
      status: 404,
      headers: { [X_HONO_DISABLE_SSG_HEADER_KEY]: "true" }
    });
  } catch {
    return null;
  }
})();
// node_modules/hono/dist/adapter/bun/ssg.js
var { write } = Bun;

// node_modules/hono/dist/helper/websocket/index.js
var WSContext = class {
  #init;
  constructor(init) {
    this.#init = init;
    this.raw = init.raw;
    this.url = init.url ? new URL(init.url) : null;
    this.protocol = init.protocol ?? null;
  }
  send(source, options) {
    this.#init.send(source, options ?? {});
  }
  raw;
  binaryType = "arraybuffer";
  get readyState() {
    return this.#init.readyState;
  }
  url;
  protocol;
  close(code, reason) {
    this.#init.close(code, reason);
  }
};
var defineWebSocketHelper = (handler) => {
  return (...args) => {
    if (typeof args[0] === "function") {
      const [createEvents, options] = args;
      return async function upgradeWebSocket(c, next) {
        const events = await createEvents(c);
        const result = await handler(c, events, options);
        if (result) {
          return result;
        }
        await next();
      };
    } else {
      const [c, events, options] = args;
      return (async () => {
        const upgraded = await handler(c, events, options);
        if (!upgraded) {
          throw new Error("Failed to upgrade WebSocket");
        }
        return upgraded;
      })();
    }
  };
};

// node_modules/hono/dist/adapter/bun/server.js
var getBunServer = (c) => ("server" in c.env) ? c.env.server : c.env;

// node_modules/hono/dist/adapter/bun/websocket.js
var upgradeWebSocket = defineWebSocketHelper((c, events) => {
  const server = getBunServer(c);
  if (!server) {
    throw new TypeError("env has to include the 2nd argument of fetch.");
  }
  const upgradeResult = server.upgrade(c.req.raw, {
    data: {
      events,
      url: new URL(c.req.url),
      protocol: c.req.url
    }
  });
  if (upgradeResult) {
    return new Response(null);
  }
  return;
});

// src/server.ts
init_ssh();

// src/commands/overview.ts
init_ssh();
function processMirror(raw2, lines) {
  const sep = "\u2500".repeat(60);
  const filtered = raw2.replace(/[\u2500\u2501]{6,}/g, sep).split(`
`).filter((l) => l.trim() !== "");
  const visible = filtered.slice(-lines);
  const pad = Math.max(0, lines - visible.length);
  return `
`.repeat(pad) + visible.join(`
`);
}

// src/feed-tail.ts
import { statSync, openSync, readSync, closeSync } from "fs";
import { join as join3 } from "path";

// src/lib/feed.ts
function parseLine(line) {
  if (!line || !line.includes(" | "))
    return null;
  const parts = line.split(" | ").map((s) => s.trim());
  if (parts.length < 5)
    return null;
  const timestamp = parts[0];
  const oracle = parts[1];
  const host = parts[2];
  const event = parts[3];
  const project = parts[4];
  const rest = parts.slice(5).join(" | ");
  let sessionId = "";
  let message = "";
  const guiIdx = rest.indexOf(" \xBB ");
  if (guiIdx !== -1) {
    sessionId = rest.slice(0, guiIdx).trim();
    message = rest.slice(guiIdx + 3).trim();
  } else {
    sessionId = rest.trim();
  }
  const ts = new Date(timestamp.replace(" ", "T") + "+07:00").getTime();
  if (isNaN(ts))
    return null;
  return { timestamp, oracle, host, event, project, sessionId, message, ts };
}
function activeOracles(events, windowMs = 5 * 60000) {
  const cutoff = Date.now() - windowMs;
  const map = new Map;
  for (const e of events) {
    if (e.ts < cutoff)
      continue;
    const prev = map.get(e.oracle);
    if (!prev || e.ts > prev.ts)
      map.set(e.oracle, e);
  }
  return map;
}

// src/feed-tail.ts
var DEFAULT_PATH = join3(process.env.HOME || "/home/nat", ".oracle", "feed.log");
var POLL_MS = 1000;
var DEFAULT_MAX_BUFFER = 200;

class FeedTailer {
  path;
  maxBuffer;
  offset = 0;
  buffer = [];
  listeners = new Set;
  timer = null;
  constructor(path, maxBuffer) {
    this.path = path || DEFAULT_PATH;
    this.maxBuffer = maxBuffer || DEFAULT_MAX_BUFFER;
  }
  start() {
    if (this.timer)
      return;
    try {
      const file = Bun.file(this.path);
      const size = file.size;
      if (size > 0) {
        const chunkSize = Math.min(size, 1e5);
        const fd = openSync(this.path, "r");
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, size - chunkSize);
        closeSync(fd);
        const text = buf.toString("utf-8");
        const lines = text.split(`
`).filter(Boolean);
        const tail = lines.slice(-this.maxBuffer);
        for (const line of tail) {
          const event = parseLine(line);
          if (event)
            this.buffer.push(event);
        }
        if (this.buffer.length > this.maxBuffer) {
          this.buffer = this.buffer.slice(-this.maxBuffer);
        }
        this.offset = size;
      }
    } catch {
      this.offset = 0;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getRecent(n) {
    const count = n || this.maxBuffer;
    return this.buffer.slice(-count);
  }
  getActive(windowMs) {
    return activeOracles(this.buffer, windowMs);
  }
  poll() {
    try {
      const stat2 = statSync(this.path);
      const size = stat2.size;
      if (size < this.offset) {
        this.offset = 0;
      }
      if (size <= this.offset)
        return;
      const newBytes = size - this.offset;
      const fd = openSync(this.path, "r");
      const buf = Buffer.alloc(newBytes);
      readSync(fd, buf, 0, newBytes, this.offset);
      closeSync(fd);
      this.offset = size;
      const text = buf.toString("utf-8");
      const lines = text.split(`
`).filter(Boolean);
      for (const line of lines) {
        const event = parseLine(line);
        if (!event)
          continue;
        this.buffer.push(event);
        for (const cb of this.listeners) {
          try {
            cb(event);
          } catch {}
        }
      }
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(-this.maxBuffer);
      }
    } catch {}
  }
}

// src/engine.ts
init_ssh();
init_tmux();

// src/handlers.ts
init_ssh();
init_config();
async function runAction(ws, action, target, fn) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}
var subscribe = (ws, data, engine) => {
  ws.data.target = data.target;
  engine.pushCapture(ws);
};
var subscribePreviews = (ws, data, engine) => {
  ws.data.previewTargets = new Set(data.targets || []);
  engine.pushPreviews(ws);
};
var select = (_ws, data) => {
  selectWindow(data.target).catch(() => {});
};
var send = async (ws, data, engine) => {
  if (!data.force) {
    try {
      const cmd = await getPaneCommand(data.target);
      if (!/claude|codex|node/i.test(cmd)) {
        ws.send(JSON.stringify({ type: "error", error: `no active Claude session in ${data.target} (running: ${cmd})` }));
        return;
      }
    } catch {}
  }
  sendKeys(data.target, data.text).then(() => {
    ws.send(JSON.stringify({ type: "sent", ok: true, target: data.target, text: data.text }));
    setTimeout(() => engine.pushCapture(ws), 300);
  }).catch((e) => ws.send(JSON.stringify({ type: "error", error: e.message })));
};
var sleep = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
};
var stop = (ws, data) => {
  runAction(ws, "stop", data.target, () => ssh(`tmux kill-window -t '${data.target}'`));
};
var wake = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
};
var restart = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03");
    await new Promise((r) => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03");
    await new Promise((r) => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
  });
};
function registerBuiltinHandlers(engine) {
  engine.on("subscribe", subscribe);
  engine.on("subscribe-previews", subscribePreviews);
  engine.on("select", select);
  engine.on("send", send);
  engine.on("sleep", sleep);
  engine.on("stop", stop);
  engine.on("wake", wake);
  engine.on("restart", restart);
}

// src/engine.ts
class MawEngine {
  clients = new Set;
  handlers = new Map;
  lastContent = new Map;
  lastPreviews = new Map;
  lastSessionsJson = "";
  cachedSessions = [];
  captureInterval = null;
  sessionInterval = null;
  previewInterval = null;
  feedUnsub = null;
  feedTailer;
  constructor({ feedTailer }) {
    this.feedTailer = feedTailer;
    registerBuiltinHandlers(this);
  }
  on(type, handler) {
    this.handlers.set(type, handler);
  }
  handleOpen(ws) {
    this.clients.add(ws);
    this.startIntervals();
    if (this.cachedSessions.length > 0) {
      ws.send(JSON.stringify({ type: "sessions", sessions: this.cachedSessions }));
      this.sendBusyAgents(ws);
    } else {
      tmux.listAll().then((sessions) => {
        this.cachedSessions = sessions;
        ws.send(JSON.stringify({ type: "sessions", sessions }));
        this.sendBusyAgents(ws);
      }).catch(() => {});
    }
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedTailer.getRecent(50) }));
  }
  async sendBusyAgents(ws) {
    const allTargets = this.cachedSessions.flatMap((s) => s.windows.map((w) => `${s.name}:${w.index}`));
    const cmds = await tmux.getPaneCommands(allTargets);
    const busy = allTargets.filter((t) => /claude|codex|node/i.test(cmds[t] || "")).map((t) => {
      const [session] = t.split(":");
      const s = this.cachedSessions.find((x) => x.name === session);
      const w = s?.windows.find((w2) => `${s.name}:${w2.index}` === t);
      return { target: t, name: w?.name || t, session };
    });
    if (busy.length > 0) {
      ws.send(JSON.stringify({ type: "recent", agents: busy }));
    }
  }
  handleMessage(ws, msg) {
    try {
      const data = JSON.parse(msg);
      const handler = this.handlers.get(data.type);
      if (handler)
        handler(ws, data, this);
    } catch {}
  }
  handleClose(ws) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
  }
  async pushCapture(ws) {
    if (!ws.data.target)
      return;
    try {
      const content = await capture(ws.data.target, 80);
      const prev = this.lastContent.get(ws);
      if (content !== prev) {
        this.lastContent.set(ws, content);
        ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  }
  async pushPreviews(ws) {
    const targets = ws.data.previewTargets;
    if (!targets || targets.size === 0)
      return;
    const prevMap = this.lastPreviews.get(ws) || new Map;
    const changed = {};
    let hasChanges = false;
    await Promise.allSettled([...targets].map(async (target) => {
      try {
        const content = await capture(target, 3);
        const prev = prevMap.get(target);
        if (content !== prev) {
          prevMap.set(target, content);
          changed[target] = content;
          hasChanges = true;
        }
      } catch {}
    }));
    this.lastPreviews.set(ws, prevMap);
    if (hasChanges) {
      ws.send(JSON.stringify({ type: "previews", data: changed }));
    }
  }
  async broadcastSessions() {
    if (this.clients.size === 0)
      return;
    try {
      const sessions = await tmux.listAll();
      this.cachedSessions = sessions;
      const json = JSON.stringify(sessions);
      if (json === this.lastSessionsJson)
        return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ type: "sessions", sessions });
      for (const ws of this.clients)
        ws.send(msg);
    } catch {}
  }
  startIntervals() {
    if (this.captureInterval)
      return;
    this.captureInterval = setInterval(() => {
      for (const ws of this.clients)
        this.pushCapture(ws);
    }, 50);
    this.sessionInterval = setInterval(() => this.broadcastSessions(), 5000);
    this.previewInterval = setInterval(() => {
      for (const ws of this.clients)
        this.pushPreviews(ws);
    }, 2000);
    this.feedTailer.start();
    this.feedUnsub = this.feedTailer.onEvent((event) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients)
        ws.send(msg);
    });
  }
  stopIntervals() {
    if (this.clients.size > 0)
      return;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    if (this.sessionInterval) {
      clearInterval(this.sessionInterval);
      this.sessionInterval = null;
    }
    if (this.previewInterval) {
      clearInterval(this.previewInterval);
      this.previewInterval = null;
    }
    if (this.feedUnsub) {
      this.feedUnsub();
      this.feedUnsub = null;
    }
    this.feedTailer.stop();
  }
}

// src/server.ts
init_config();
import { readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, renameSync, unlinkSync, existsSync as existsSync2 } from "fs";
import { join as join5, basename } from "path";

// src/worktrees.ts
init_ssh();
init_config();
import { readdirSync, readFileSync as readFileSync2 } from "fs";
import { join as join4 } from "path";
async function scanWorktrees() {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = join4(import.meta.dir, "../fleet");
  let wtPaths = [];
  try {
    const raw2 = await ssh(`find ${ghqRoot} -maxdepth 4 -name '*.wt-*' -type d 2>/dev/null`);
    wtPaths = raw2.split(`
`).filter(Boolean);
  } catch {}
  const sessions = await listSessions();
  const runningWindows = new Set;
  for (const s of sessions) {
    for (const w of s.windows) {
      runningWindows.add(w.name);
    }
  }
  const fleetWindows = new Map;
  try {
    for (const file of readdirSync(fleetDir).filter((f) => f.endsWith(".json"))) {
      const cfg = JSON.parse(readFileSync2(join4(fleetDir, file), "utf-8"));
      for (const w of cfg.windows || []) {
        if (w.repo)
          fleetWindows.set(w.repo, file);
      }
    }
  } catch {}
  const results = [];
  for (const wtPath of wtPaths) {
    const dirName = wtPath.split("/").pop();
    const parts = dirName.split(".wt-");
    if (parts.length < 2)
      continue;
    const mainRepoName = parts[0];
    const wtName = parts[1];
    const relPath = wtPath.replace(ghqRoot + "/", "");
    const parentParts = relPath.split("/");
    parentParts.pop();
    const org = parentParts.join("/");
    const mainRepo = `${org}/${mainRepoName}`;
    const repo = `${org}/${dirName}`;
    let branch = "";
    try {
      branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
    } catch {
      branch = "unknown";
    }
    let tmuxWindow;
    const fleetFile = fleetWindows.get(repo);
    for (const s of sessions) {
      for (const w of s.windows) {
        const taskPart = wtName.replace(/^\d+-/, "");
        if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
          tmuxWindow = w.name;
        }
      }
    }
    const status = tmuxWindow ? "active" : "stale";
    results.push({
      path: wtPath,
      branch,
      repo,
      mainRepo,
      name: wtName,
      status,
      tmuxWindow,
      fleetFile
    });
  }
  const mainRepos = [...new Set(results.map((r) => r.mainRepo))];
  for (const mainRepo of mainRepos) {
    const mainPath = join4(ghqRoot, mainRepo);
    try {
      const prunable = await ssh(`git -C '${mainPath}' worktree list --porcelain 2>/dev/null | grep -A1 'prunable' | grep 'worktree' | sed 's/worktree //'`);
      for (const orphanPath of prunable.split(`
`).filter(Boolean)) {
        const existing = results.find((r) => r.path === orphanPath);
        if (existing) {
          existing.status = "orphan";
        } else {
          const dirName = orphanPath.split("/").pop() || "";
          results.push({
            path: orphanPath,
            branch: "(prunable)",
            repo: dirName,
            mainRepo,
            name: dirName,
            status: "orphan"
          });
        }
      }
    } catch {}
  }
  return results;
}
async function cleanupWorktree(wtPath) {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = join4(import.meta.dir, "../fleet");
  const log = [];
  const dirName = wtPath.split("/").pop();
  const parts = dirName.split(".wt-");
  if (parts.length < 2) {
    log.push(`not a worktree: ${dirName}`);
    return log;
  }
  const mainRepoName = parts[0];
  const relPath = wtPath.replace(ghqRoot + "/", "");
  const parentParts = relPath.split("/");
  parentParts.pop();
  const org = parentParts.join("/");
  const mainPath = join4(ghqRoot, org, mainRepoName);
  const repo = `${org}/${dirName}`;
  const sessions = await listSessions();
  const wtName = parts[1];
  const taskPart = wtName.replace(/^\d+-/, "");
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
        try {
          await ssh(`tmux kill-window -t '${s.name}:${w.name}'`);
          log.push(`killed window ${s.name}:${w.name}`);
        } catch {
          log.push(`window already closed: ${w.name}`);
        }
      }
    }
  }
  let branch = "";
  try {
    branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim();
  } catch {}
  try {
    await ssh(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
    await ssh(`git -C '${mainPath}' worktree prune`);
    log.push(`removed worktree ${dirName}`);
  } catch (e) {
    log.push(`worktree remove failed: ${e.message || e}`);
  }
  if (branch && branch !== "main" && branch !== "HEAD" && branch !== "unknown") {
    try {
      await ssh(`git -C '${mainPath}' branch -d '${branch}'`);
      log.push(`deleted branch ${branch}`);
    } catch {
      log.push(`branch ${branch} not deleted (may have unmerged changes)`);
    }
  }
  try {
    for (const file of readdirSync(fleetDir).filter((f) => f.endsWith(".json"))) {
      const filePath = join4(fleetDir, file);
      const cfg = JSON.parse(readFileSync2(filePath, "utf-8"));
      const before = cfg.windows?.length || 0;
      cfg.windows = (cfg.windows || []).filter((w) => w.repo !== repo);
      if (cfg.windows.length < before) {
        const { writeFileSync: writeFileSync2 } = await import("fs");
        writeFileSync2(filePath, JSON.stringify(cfg, null, 2) + `
`);
        log.push(`removed from ${file}`);
      }
    }
  } catch {}
  return log;
}

// src/pty.ts
init_tmux();
init_config();
var nextPtyId = 0;
var sessions = new Map;
function isLocalHost() {
  const host = process.env.MAW_HOST || loadConfig().host || "white.local";
  return host === "local" || host === "localhost";
}
function findSession(ws) {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws))
      return s;
  }
}
function handlePtyMessage(ws, msg) {
  if (typeof msg !== "string") {
    const session = findSession(ws);
    if (session?.proc.stdin) {
      session.proc.stdin.write(msg);
      session.proc.stdin.flush();
    }
    return;
  }
  try {
    const data = JSON.parse(msg);
    if (data.type === "attach")
      attach(ws, data.target, data.cols || 120, data.rows || 40);
    else if (data.type === "resize")
      resize(ws, data.cols, data.rows);
    else if (data.type === "detach")
      detach(ws);
  } catch {}
}
function handlePtyClose(ws) {
  detach(ws);
}
async function attach(ws, target, cols, rows) {
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe)
    return;
  detach(ws);
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }
  const sessionName = safe.split(":")[0];
  const windowPart = safe.includes(":") ? safe.split(":").slice(1).join(":") : "";
  const c = Math.max(1, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(200, Math.floor(rows)));
  const ptySessionName = `maw-pty-${++nextPtyId}`;
  try {
    await tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c,
      rows: r,
      window: windowPart || undefined
    });
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));
    return;
  }
  let args;
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`;
    args = ["script", "-qfc", cmd, "/dev/null"];
  } else {
    const host = process.env.MAW_HOST || loadConfig().host || "white.local";
    args = ["ssh", "-tt", host, `TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`];
  }
  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TERM: "xterm-256color" }
  });
  session = { proc, target: safe, ptySessionName, viewers: new Set([ws]), cleanupTimer: null };
  sessions.set(safe, session);
  ws.send(JSON.stringify({ type: "attached", target: safe }));
  const s = session;
  const reader = proc.stdout.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        for (const v of s.viewers) {
          try {
            v.send(value);
          } catch {}
        }
      }
    } catch {}
    sessions.delete(safe);
    tmux.killSession(s.ptySessionName);
    for (const v of s.viewers) {
      try {
        v.send(JSON.stringify({ type: "detached", target: safe }));
      } catch {}
    }
  })();
}
function resize(_ws, _cols, _rows) {}
function detach(ws) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws))
      continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      session.cleanupTimer = setTimeout(() => {
        try {
          session.proc.kill();
        } catch {}
        tmux.killSession(session.ptySessionName);
        sessions.delete(target);
      }, 5000);
    }
  }
}

// src/server.ts
var app = new Hono2;
app.use("/api/*", cors());
app.get("/api/sessions", async (c) => c.json(await listSessions()));
app.get("/api/capture", async (c) => {
  const target = c.req.query("target");
  if (!target)
    return c.json({ error: "target required" }, 400);
  try {
    return c.json({ content: await capture(target) });
  } catch (e) {
    return c.json({ content: "", error: e.message });
  }
});
app.get("/api/mirror", async (c) => {
  const target = c.req.query("target");
  if (!target)
    return c.text("target required", 400);
  const lines = +(c.req.query("lines") || "40");
  const raw2 = await capture(target);
  return c.text(processMirror(raw2, lines));
});
app.post("/api/send", async (c) => {
  const { target, text } = await c.req.json();
  if (!target || !text)
    return c.json({ error: "target and text required" }, 400);
  await sendKeys(target, text);
  return c.json({ ok: true, target, text });
});
app.post("/api/select", async (c) => {
  const { target } = await c.req.json();
  if (!target)
    return c.json({ error: "target required" }, 400);
  await selectWindow(target);
  return c.json({ ok: true, target });
});
app.get("/", serveStatic2({ root: "./dist-office", path: "/index.html" }));
app.get("/dashboard", (c) => c.redirect("/#orbital"));
app.get("/office", (c) => c.redirect("/#office"));
app.get("/assets/*", serveStatic2({ root: "./dist-office" }));
app.get("/office/*", serveStatic2({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/office/, "/dist-office")
}));
app.get("/office-8bit", serveStatic2({ root: "./dist-8bit-office", path: "/index.html" }));
app.get("/office-8bit/*", serveStatic2({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/dist-8bit-office")
}));
app.get("/war-room", serveStatic2({ root: "./dist-war-room", path: "/index.html" }));
app.get("/war-room/*", serveStatic2({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/war-room/, "/dist-war-room")
}));
app.get("/race-track", serveStatic2({ root: "./dist-race-track", path: "/index.html" }));
app.get("/race-track/*", serveStatic2({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/race-track/, "/dist-race-track")
}));
app.get("/superman", serveStatic2({ root: "./dist-superman", path: "/index.html" }));
app.get("/superman/*", serveStatic2({
  root: "./",
  rewriteRequestPath: (p) => p.replace(/^\/superman/, "/dist-superman")
}));
var ORACLE_URL = process.env.ORACLE_URL || loadConfig().oracleUrl;
app.get("/api/oracle/search", async (c) => {
  const q2 = c.req.query("q");
  if (!q2)
    return c.json({ error: "q required" }, 400);
  const params = new URLSearchParams({ q: q2, mode: c.req.query("mode") || "hybrid", limit: c.req.query("limit") || "10" });
  const model = c.req.query("model");
  if (model)
    params.set("model", model);
  try {
    const res = await fetch(`${ORACLE_URL}/api/search?${params}`);
    return c.json(await res.json());
  } catch (e) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});
app.get("/api/oracle/traces", async (c) => {
  const limit = c.req.query("limit") || "10";
  try {
    const res = await fetch(`${ORACLE_URL}/api/traces?limit=${limit}`);
    return c.json(await res.json());
  } catch (e) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});
app.get("/api/oracle/stats", async (c) => {
  try {
    const res = await fetch(`${ORACLE_URL}/api/stats`);
    return c.json(await res.json());
  } catch (e) {
    return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
  }
});
var uiStatePath = join5(import.meta.dir, "../ui-state.json");
app.get("/api/ui-state", (c) => {
  try {
    if (!existsSync2(uiStatePath))
      return c.json({});
    return c.json(JSON.parse(readFileSync3(uiStatePath, "utf-8")));
  } catch {
    return c.json({});
  }
});
app.post("/api/ui-state", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync2(uiStatePath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
var asksPath = join5(import.meta.dir, "../asks.json");
app.get("/api/asks", (c) => {
  try {
    if (!existsSync2(asksPath))
      return c.json([]);
    return c.json(JSON.parse(readFileSync3(asksPath, "utf-8")));
  } catch {
    return c.json([]);
  }
});
app.post("/api/asks", async (c) => {
  try {
    const body = await c.req.json();
    writeFileSync2(asksPath, JSON.stringify(body, null, 2), "utf-8");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
var fleetDir = join5(import.meta.dir, "../fleet");
app.get("/api/fleet-config", (c) => {
  try {
    const files = readdirSync2(fleetDir).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map((f) => JSON.parse(readFileSync3(join5(fleetDir, f), "utf-8")));
    return c.json({ configs });
  } catch (e) {
    return c.json({ configs: [], error: e.message });
  }
});
app.get("/api/config-files", (c) => {
  const files = [
    { name: "maw.config.json", path: "maw.config.json", enabled: true }
  ];
  try {
    const entries = readdirSync2(fleetDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
    for (const f of entries) {
      const enabled = !f.endsWith(".disabled");
      files.push({ name: f, path: `fleet/${f}`, enabled });
    }
  } catch {}
  return c.json({ files });
});
app.get("/api/config-file", (c) => {
  const filePath = c.req.query("path");
  if (!filePath)
    return c.json({ error: "path required" }, 400);
  const fullPath = join5(import.meta.dir, "..", filePath);
  if (!existsSync2(fullPath))
    return c.json({ error: "not found" }, 404);
  try {
    const content = readFileSync3(fullPath, "utf-8");
    if (filePath === "maw.config.json") {
      const data = JSON.parse(content);
      const display = configForDisplay();
      data.env = display.envMasked;
      return c.json({ content: JSON.stringify(data, null, 2) });
    }
    return c.json({ content });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
app.post("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath)
    return c.json({ error: "path required" }, 400);
  if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
    return c.json({ error: "invalid path" }, 403);
  }
  try {
    const { content } = await c.req.json();
    JSON.parse(content);
    const fullPath = join5(import.meta.dir, "..", filePath);
    if (filePath === "maw.config.json") {
      const parsed = JSON.parse(content);
      if (parsed.env && typeof parsed.env === "object") {
        const current = loadConfig();
        for (const [k, v] of Object.entries(parsed.env)) {
          if (/\u2022/.test(v))
            parsed.env[k] = current.env[k] || v;
        }
      }
      saveConfig(parsed);
    } else {
      writeFileSync2(fullPath, content + `
`, "utf-8");
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
app.post("/api/config-file/toggle", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/"))
    return c.json({ error: "invalid path" }, 400);
  const fullPath = join5(import.meta.dir, "..", filePath);
  if (!existsSync2(fullPath))
    return c.json({ error: "not found" }, 404);
  const isDisabled = filePath.endsWith(".disabled");
  const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
  const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
  renameSync(fullPath, newPath);
  return c.json({ ok: true, newPath: newRelPath });
});
app.delete("/api/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/"))
    return c.json({ error: "cannot delete" }, 400);
  const fullPath = join5(import.meta.dir, "..", filePath);
  if (!existsSync2(fullPath))
    return c.json({ error: "not found" }, 404);
  unlinkSync(fullPath);
  return c.json({ ok: true });
});
app.put("/api/config-file", async (c) => {
  const { name, content } = await c.req.json();
  if (!name || !name.endsWith(".json"))
    return c.json({ error: "name must end with .json" }, 400);
  const safeName = basename(name);
  const fullPath = join5(fleetDir, safeName);
  if (existsSync2(fullPath))
    return c.json({ error: "file already exists" }, 409);
  try {
    JSON.parse(content);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  writeFileSync2(fullPath, content + `
`, "utf-8");
  return c.json({ ok: true, path: `fleet/${safeName}` });
});
app.get("/api/config", (c) => {
  if (c.req.query("raw") === "1")
    return c.json(loadConfig());
  return c.json(configForDisplay());
});
app.post("/api/config", async (c) => {
  try {
    const body = await c.req.json();
    if (body.env && typeof body.env === "object") {
      const current = loadConfig();
      const merged = {};
      for (const [k, v] of Object.entries(body.env)) {
        merged[k] = /\u2022/.test(v) ? current.env[k] || v : v;
      }
      body.env = merged;
    }
    saveConfig(body);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
app.get("/api/worktrees", async (c) => {
  try {
    return c.json(await scanWorktrees());
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
app.post("/api/worktrees/cleanup", async (c) => {
  const { path } = await c.req.json();
  if (!path)
    return c.json({ error: "path required" }, 400);
  try {
    const log = await cleanupWorktree(path);
    return c.json({ ok: true, log });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
var feedTailer = new FeedTailer;
app.get("/api/feed", (c) => {
  const limit = Math.min(200, +(c.req.query("limit") || "50"));
  const oracle = c.req.query("oracle") || undefined;
  let events = feedTailer.getRecent(limit);
  if (oracle)
    events = events.filter((e) => e.oracle === oracle);
  const active = [...feedTailer.getActive().keys()];
  return c.json({ events: events.reverse(), total: events.length, active_oracles: active });
});
app.onError((err, c) => c.json({ error: err.message }, 500));
function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedTailer });
  const server = Bun.serve({
    port,
    fetch(req, server2) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/pty") {
        if (server2.upgrade(req, { data: { target: null, previewTargets: new Set, mode: "pty" } }))
          return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ws") {
        if (server2.upgrade(req, { data: { target: null, previewTargets: new Set } }))
          return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        if (ws.data.mode === "pty")
          return;
        engine.handleOpen(ws);
      },
      message: (ws, msg) => {
        if (ws.data.mode === "pty") {
          handlePtyMessage(ws, msg);
          return;
        }
        engine.handleMessage(ws, msg);
      },
      close: (ws) => {
        if (ws.data.mode === "pty") {
          handlePtyClose(ws);
          return;
        }
        engine.handleClose(ws);
      }
    }
  });
  console.log(`maw serve \u2192 http://localhost:${port} (ws://localhost:${port}/ws)`);
  return server;
}
if (!process.env.MAW_CLI) {
  startServer();
}
export {
  startServer,
  app
};
