import { run } from "@agent-autoloop/feishu-a2ui/cli";

// Only result metadata crosses the host boundary; prompts, bodies and raw logs stay on the execution host.
export function snapshotScript(database: string, project: string) {
  return `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(database)}, {readOnly:true});
try {
  db.exec('BEGIN');
  const rows = table => db.prepare('SELECT body FROM '+table+' ORDER BY rowid').all().map(r=>JSON.parse(r.body));
  const runs=rows('loop_runs'), run=runs.at(-1);
  if(!run || run.project!==${JSON.stringify(project)}) throw Error('execution_project_mismatch');
  const dates=new Map();
  const blocker=e=>!e?null:/^PR closed without merge/.test(e)?'pr-closed':/PR head changed/.test(e)?'pr-head-changed':/scope|authorization|policy|sensitive/i.test(e)?'authorization':/cleanup|process.*unverified/i.test(e)?'cleanup':'execution';
  for(const e of db.prepare("SELECT entity,at FROM events WHERE type IN ('loop.state','task.merged','task.pr-closed') ORDER BY seq").all()) dates.set(e.entity,e.at);
  const items=rows('loop_items').map(i=>({
    id:i.id,repo:i.repo,number:i.number,title:i.input?.title,state:i.state,taskIds:i.taskIds||[],
    author:i.input?.user?.login,avatarUrl:i.input?.user?.avatar_url,
    createdAt:i.input?.created_at,updatedAt:i.input?.updated_at,resultAt:dates.get(i.id)||i.at,
    summary:i.decision?.summary,reason:i.decision?.reason,blocker:blocker(i.error),comment:i.comment?{html_url:i.comment.html_url}:null,
    triageAttempts:i.triageAttempts,pr:i.pr?{state:i.pr.state,green:i.pr.green,failed:i.pr.failed,head:i.pr.head}:null
  }));
  const tasks=rows('tasks').map(t=>({id:t.id,state:t.state,prUrl:t.prUrl,attempts:t.attempts,blocker:blocker(t.error),resultAt:dates.get(t.id),
    result:t.result?{summary:t.result.summary,headSha:t.result.headSha,limitations:t.result.limitations}:null}));
  db.exec('COMMIT');
  console.log(JSON.stringify({project:run.project,run:{id:run.id,state:run.state,deadline:run.deadline},items,tasks}));
} finally {db.close();}`;
}

export async function readSnapshot(
  c: { sourceCommand: string[]; databaseFile: string; project: string },
  signal?: AbortSignal,
) {
  return JSON.parse(await run(c.sourceCommand, [], snapshotScript(c.databaseFile, c.project), signal, 25_000));
}
