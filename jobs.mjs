// In-memory journal for running builds: event log, current status, live draft and streamed text.
// In cloud/memory mode (§3.3), events are also batched into `run_events` every 1 s (up to 100 rows)
// and a heartbeat is sent every 10 s.
const jobs = new Map();
const KEEP_MS = 15 * 60 * 1000;
const EVENT_FLUSH_MS = 1000;
const HEARTBEAT_MS = 10000;

let runSink = null;

export function setJobRunSink(sink) {
  runSink = sink;
}

const clock = ms => '+' + (ms / 1000).toFixed(1) + 's';

export async function flushJobEvents(job) {
  if (!job || !runSink?.events) return;
  while (job.flushedIndex < job.events.length) {
    const batch = job.events.slice(job.flushedIndex, job.flushedIndex + 100);
    job.flushedIndex += batch.length;
    try {
      await runSink.events(job.id, batch);
    } catch {}
  }
}

export function createJob(id, info = {}) {
  const job = {
    id,
    ...info,
    started: Date.now(),
    events: [],
    flushedIndex: 0,
    status: '',
    text: '',
    tail: '',
    sketches: [],
    draft: null,
    done: false,
    costs: {llm: 0, image: 0, video: 0, total: 0, unknown: false},
    flushTimer: null,
    heartbeatTimer: null,
  };

  job.flushTimer = setInterval(() => {
    flushJobEvents(job).catch(() => {});
  }, EVENT_FLUSH_MS);
  job.flushTimer.unref?.();

  job.heartbeatTimer = setInterval(() => {
    if (job.done || !runSink?.heartbeat) return;
    runSink.heartbeat(job.id, {statusText: job.status, costs: job.costs}).catch(() => {});
  }, HEARTBEAT_MS);
  job.heartbeatTimer.unref?.();

  jobs.set(id, job);
  return job;
}

export const getJob = id => jobs.get(id);

// log(message, {level:'info'|'step'|'think'|'warn'|'error'|'done', detail, media, quiet, cost:{kind:'llm'|'image'|'video', usd}})
export function logger(job, {mediaURL = file => file} = {}) {
  return (msg, extra = {}) => {
    if (!job) return;
    const event = {i: job.events.length, at: Date.now() - job.started, level: extra.level || 'info', msg: String(msg)};
    if (extra.detail) event.detail = String(extra.detail).slice(0, 4000);
    if (extra.media) event.media = {...extra.media, url: mediaURL(extra.media.file)};
    if (extra.cost) {
      event.cost = extra.cost;
      if (typeof extra.cost.usd === 'number') {
        job.costs[extra.cost.kind] = (job.costs[extra.cost.kind] || 0) + extra.cost.usd;
        job.costs.total += extra.cost.usd;
      } else {
        job.costs.unknown = true;
      }
    }
    job.events.push(event);
    if (!extra.quiet && event.level !== 'think') {
      job.status = event.msg;
      if (runSink?.heartbeat) {
        runSink.heartbeat(job.id, {statusText: job.status, costs: job.costs}).catch(() => {});
      }
    }
    const tag = '[forma ' + job.id.slice(0, 8) + ' ' + clock(event.at) + ']';
    const line =
      tag +
      ' ' +
      event.level.toUpperCase().padEnd(5) +
      ' ' +
      event.msg +
      (event.detail && event.level !== 'think' ? ' — ' + event.detail.replace(/\s+/g, ' ').slice(0, 300) : '');
    (event.level === 'error' ? console.error : console.log)(line);
  };
}

export function finishJob(job, {status = 'done', entryId = null} = {}) {
  if (!job) return;
  job.done = true;
  if (job.flushTimer) {
    clearInterval(job.flushTimer);
    job.flushTimer = null;
  }
  if (job.heartbeatTimer) {
    clearInterval(job.heartbeatTimer);
    job.heartbeatTimer = null;
  }
  flushJobEvents(job)
    .then(() => {
      if (runSink?.finish) {
        return runSink.finish(job.id, {
          status,
          statusText: job.status,
          costs: job.costs,
          entryId,
          log: job.events,
        });
      }
    })
    .catch(() => {});
  setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.();
}

export function snapshot(job, since = 0) {
  return {
    status: job.status,
    done: job.done,
    elapsed: Date.now() - job.started,
    costs: job.costs,
    events: job.events.slice(since),
    next: job.events.length,
    draft: job.draft,
    text: job.task === 'scenario' ? job.text : undefined,
    tail: ['creative', 'preview', 'final'].includes(job.task) ? job.tail : undefined,
    sketches: ['style', 'styles'].includes(job.task) ? job.sketches : undefined,
    sketchTotal: ['style', 'styles'].includes(job.task) ? job.sketchTotal || 3 : undefined,
  };
}

// Turns a half-written HTML document into something renderable: no scripts, no dangling tag.
export function draftHTML(text) {
  let html = text.replace(/^`{3}(?:html)?\s*/i, '');
  const start = html.search(/<html[\s>]/i);
  if (start < 0) return null;
  html = html.slice(start);
  if (!/<body[\s>]/i.test(html)) return null;
  html = html.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '').replace(/<[^>]*$/, '');
  return /<\/body\s*>/i.test(html) ? html : html + '</body></html>';
}

// Pulls the finished "svg" strings out of a partially streamed style-pitch JSON.
export function streamedSketches(text) {
  const found = [];
  for (const match of text.matchAll(/"svg"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      found.push(JSON.parse('"' + match[1] + '"'));
    } catch {}
  }
  return found.filter(svg => /^<svg[\s>]/i.test(svg.trim()) && /<\/svg>$/i.test(svg.trim()));
}
