import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport { loadUpcomingAssignments, processSyncCourseJob };', {
  loader: 'ts', format: 'cjs', target: 'es2022'
}).code;
const context = { module: { exports: {} }, Date, console };
vm.runInNewContext(code, context);
const { loadUpcomingAssignments, processSyncCourseJob } = context.module.exports;

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE assignments(chat_id INTEGER,title TEXT,course TEXT,assignment_type TEXT,due_at TEXT,submitted INTEGER);
    CREATE INDEX idx_assignments_chat_due ON assignments(chat_id,due_at);
    CREATE TABLE sync_runs(run_id TEXT PRIMARY KEY,chat_id INTEGER,status TEXT,course_count INTEGER);
    CREATE TABLE sync_run_courses(run_id TEXT,position INTEGER,course_json TEXT,status TEXT,PRIMARY KEY(run_id,position));`);
  const sent = [];
  let reads = 0;
  const env = { DB: { prepare(sql) { return { bind(...args) { return {
    async first() { reads++; return db.prepare(sql).get(...args) ?? null; },
    async all() { reads++; return { results: db.prepare(sql).all(...args) }; }
  }; } }; } }, SYNC_QUEUE: { async send(job) { sent.push(job); } } };
  return { db, env, sent, reads: () => reads };
}

test('upcoming lookup includes submitted, excludes expired and other users', async () => {
  const f = fixture();
  for (const row of [[1,'submitted','2099-01-01',1],[1,'pending','2099-01-02',0],
    [1,'expired','2000-01-01',0],[2,'private','2099-01-01',0]]) {
    f.db.prepare("INSERT INTO assignments VALUES(?,?,'Course','Hands-on',?,?)").run(...row);
  }
  const result = await loadUpcomingAssignments(f.env, 1);
  assert.deepEqual(result.results.map(r => r.title), ['submitted','pending']);
  const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM assignments WHERE chat_id=? AND due_at>?').all(1,'2026');
  assert.match(plan.map(r => r.detail).join(' '), /idx_assignments_chat_due.*due_at>/);
  f.db.close();
});

for (const [label, status, chatId, checkpoint, expected] of [
  ['done checkpoint resumes', 'running', 1, true, 1],
  ['missing checkpoint preserves continuation', 'running', 1, false, 1],
  ['cancelled run does nothing', 'cancelled', 1, true, 0],
  ['other user cannot resume run', 'running', 2, true, 0]
]) test(label, async () => {
  const f = fixture();
  f.db.prepare('INSERT INTO sync_runs VALUES(?,?,?,3)').run('run',chatId,status);
  if (checkpoint) f.db.exec("INSERT INTO sync_run_courses VALUES('run',0,'{}','done')");
  await processSyncCourseJob(f.env, { kind:'sync-course',runId:'run',chatId:1,position:0,enqueuedAt:'now' });
  assert.equal(f.reads(),1);
  assert.equal(f.sent.length,expected);
  if (expected) assert.equal(f.sent[0].position,1);
  f.db.close();
});
