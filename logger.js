const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
const minLevel = LEVELS[envLevel] ?? LEVELS.info;
const isProd = process.env.NODE_ENV === "production";

const COLORS = {
  debug: "\x1b[36m",
  info:  "\x1b[32m",
  warn:  "\x1b[33m",
  error: "\x1b[31m",
  dim:   "\x1b[2m",
  reset: "\x1b[0m",
};

function serialize(ctx) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null) continue;
    if (v instanceof Error) {
      out[k] = v.message;
      out.stack = v.stack;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatDev(level, msg, ctx) {
  const time = new Date().toISOString().slice(11, 23);
  const color = COLORS[level];
  const label = `${color}[${level.toUpperCase().padEnd(5)}]${COLORS.reset}`;
  const entries = Object.entries(ctx);
  const ctxStr = entries.length
    ? " " + entries.map(([k, v]) => `${COLORS.dim}${k}=${COLORS.reset}${JSON.stringify(v)}`).join(" ")
    : "";
  const stackStr = ctx.stack ? `\n${COLORS.dim}${ctx.stack}${COLORS.reset}` : "";
  return `${label} ${COLORS.dim}${time}${COLORS.reset} ${msg}${ctxStr}${stackStr}`;
}

function formatProd(level, msg, ctx) {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx });
}

function log(level, msg, ctx = {}) {
  if (LEVELS[level] < minLevel) return;
  const safe = serialize(ctx);
  const line = isProd ? formatProd(level, msg, safe) : formatDev(level, msg, safe);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function makeLogger(defaults = {}) {
  return {
    debug: (msg, ctx = {}) => log("debug", msg, { ...defaults, ...ctx }),
    info:  (msg, ctx = {}) => log("info",  msg, { ...defaults, ...ctx }),
    warn:  (msg, ctx = {}) => log("warn",  msg, { ...defaults, ...ctx }),
    error: (msg, ctx = {}) => log("error", msg, { ...defaults, ...ctx }),
    child: (extra = {}) => makeLogger({ ...defaults, ...extra }),
  };
}

export const logger = makeLogger();

// Express middleware: logs every request with a short request ID, method, path, status, and duration.
export function requestLogger(req, res, next) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const start = Date.now();
  req.log = logger.child({ reqId });

  const query = Object.keys(req.query).length ? req.query : undefined;
  req.log.info(`→ ${req.method} ${req.path}`, { ip: req.ip, ...(query && { query }) });

  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    req.log[level](`← ${req.method} ${req.path}`, { status: res.statusCode, ms });
  });

  next();
}
