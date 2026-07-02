/**
 * perf-monitor.js — request timing + event-loop lag instrumentation.
 *
 * Why: this app runs sql.js (in-memory, synchronous) plus synchronous
 * PDF/Excel/DBF generation, all on Node's single event-loop thread. When one
 * request runs heavy synchronous work it blocks the WHOLE process, so every
 * other in-flight request — including static file serving — stalls behind it.
 * That looks like "the database is locked / slow" but it is event-loop
 * starvation. This module measures both so the real blocker is identifiable
 * from Railway logs instead of guessed at.
 *
 * Two independent signals:
 *   1. Per-request duration — logs any request slower than SLOW_MS, tagging it
 *      with how many other requests were in flight at the same time.
 *   2. Event-loop lag — a fixed-interval timer measures how late it actually
 *      fires. Lateness == time the loop was blocked. When it spikes we dump
 *      the requests that were in flight during the block: those are the
 *      culprits.
 *
 * Nothing here does async/heavy work; the sampler is O(in-flight) and cheap.
 */

'use strict';

const SLOW_MS = Number(process.env.PERF_SLOW_MS || 1000);   // log requests slower than this
const LAG_WARN_MS = Number(process.env.PERF_LAG_MS || 200); // log loop blocks longer than this
const LAG_INTERVAL_MS = 500;                                // sampler cadence
const MAX_LOG = 300;                                        // ring-buffer cap per log

// Live set of in-flight requests: id -> { method, url, startMs, startNs }
const inFlight = new Map();
let reqSeq = 0;

// Ring buffers surfaced via /api/_perf
const slowLog = [];
const lagLog = [];
let lagMaxMs = 0;
let lagCount = 0;

function push(buf, rec) {
  buf.push(rec);
  if (buf.length > MAX_LOG) buf.shift();
}

/**
 * Express middleware. Register FIRST — before express.json and
 * express.static — so it also times body parsing and static file serving
 * (the 80s homepage hang was a static request, which never touches the DB).
 */
function middleware(req, res, next) {
  const id = ++reqSeq;
  const startNs = process.hrtime.bigint();
  const entry = {
    method: req.method,
    url: req.originalUrl || req.url,
    startMs: Date.now(),
    startNs,
  };
  inFlight.set(id, entry);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight.delete(id);
    const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
    if (ms >= SLOW_MS) {
      const rec = {
        t: new Date().toISOString(),
        method: entry.method,
        url: entry.url,
        status: res.statusCode,
        ms: Math.round(ms),
        concurrent: inFlight.size, // others still running when this finished
      };
      push(slowLog, rec);
      console.warn(
        `[perf] SLOW ${rec.method} ${rec.url} -> ${rec.status} ${rec.ms}ms` +
          (rec.concurrent ? ` (${rec.concurrent} still in-flight)` : '')
      );
    }
  };

  // 'finish' fires on a normal response; 'close' catches aborted/dropped
  // connections so we never leak an entry in inFlight.
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

/**
 * Start the event-loop lag sampler. Call once after the server starts.
 * Returns the timer (already unref'd so it won't keep the process alive).
 */
function startLagMonitor() {
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - last) / 1e6;
    last = now;
    const drift = elapsedMs - LAG_INTERVAL_MS; // how much later than scheduled
    if (drift > lagMaxMs) lagMaxMs = drift;
    if (drift >= LAG_WARN_MS) {
      lagCount++;
      // Snapshot who was running during the block. These are the requests
      // that most likely caused (or were caught in) the stall.
      const busy = [...inFlight.values()].map(
        (e) => `${e.method} ${e.url} (running ${Date.now() - e.startMs}ms)`
      );
      const rec = {
        t: new Date().toISOString(),
        blockedMs: Math.round(drift),
        inFlight: busy,
      };
      push(lagLog, rec);
      console.warn(
        `[perf] EVENT-LOOP BLOCKED ~${rec.blockedMs}ms — in-flight: ` +
          (busy.length ? busy.join(' | ') : 'none')
      );
    }
  }, LAG_INTERVAL_MS);
  timer.unref();
  return timer;
}

/** Snapshot for the /api/_perf diagnostic endpoint. */
function snapshot() {
  return {
    now: new Date().toISOString(),
    thresholds: { slowMs: SLOW_MS, lagWarnMs: LAG_WARN_MS },
    eventLoop: { maxBlockMs: Math.round(lagMaxMs), blockEvents: lagCount },
    inFlight: [...inFlight.values()].map((e) => ({
      method: e.method,
      url: e.url,
      runningMs: Date.now() - e.startMs,
    })),
    slowRequests: slowLog.slice().reverse(), // newest first
    loopBlocks: lagLog.slice().reverse(),
  };
}

module.exports = { middleware, startLagMonitor, snapshot };
