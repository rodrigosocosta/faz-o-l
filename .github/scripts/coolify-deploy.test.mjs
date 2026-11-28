import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleCommit, triggerDeployment } from './coolify-deploy.mjs';

const sha = 'a'.repeat(40);
const ok = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', updated_at: '2026-11-28T00:00:00Z' };
const input = { sha, latestSha: sha, runs: [[ok], [ok]] };

test('deploy only after CI and desktop publication succeed for the latest commit', () => {
  assert.equal(eligibleCommit(input), true);
  for (const runs of [[[ok], []], [[ok], [{...ok, conclusion:'failure'}]], [[ok], [{...ok, status:'in_progress'}]]]) {
    assert.equal(eligibleCommit({...input,runs}),false);
  }
  assert.equal(eligibleCommit({...input,latestSha:'b'.repeat(40)}),false);
  assert.equal(eligibleCommit({...input,runs:[[{...ok,event:'pull_request'}],[ok]]}),false);
});

test('a failed rerun supersedes an earlier successful check', () => {
  const failed = {...ok,conclusion:'failure',updated_at:'2026-11-28T01:00:00Z'};
  assert.equal(eligibleCommit({...input,runs:[[ok,failed],[ok]]}),false);
});

test('deployment pins the checked commit before requesting a build', async () => {
  const calls = [];
  const fetcher = async (url,options) => {
    calls.push({url,options});
    return {ok:true,json:async()=>url.endsWith('/start')?{deployment_uuid:'job'}:{deployments:[]}};
  };
  const result = await triggerDeployment({url:'http://100.64.0.1:8000',token:'private',uuid:'app',sha,fetcher});
  assert.equal(result,'job');
  assert.equal(calls[1].options.method,'PATCH');
  assert.equal(JSON.parse(calls[1].options.body).git_commit_sha,sha);
  assert.equal(calls[2].url,'http://100.64.0.1:8000/api/v1/applications/app/start');
  assert.equal(calls[2].options.redirect,'error');
});

test('the second workflow completion does not queue the same deployment twice', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;return {ok:true,json:async()=>({deployments:[{commit:sha,status:'queued'}]})};};
  assert.equal(await triggerDeployment({url:'http://100.64.0.1:8000',token:'private',uuid:'app',sha,fetcher}),null);
  assert.equal(calls,1);
});

test('invalid public HTTP endpoints and failed configuration never start a deploy', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;return {ok:false,status:401,json:async()=>({message:'private'})};};
  await assert.rejects(triggerDeployment({url:'http://example.com',token:'private',uuid:'app',sha,fetcher}));
  assert.equal(calls,0);
  await assert.rejects(triggerDeployment({url:'http://100.64.0.1:8000',token:'private',uuid:'app',sha,fetcher}), /HTTP 401/);
  const refused = async () => { throw new TypeError('fetch failed', {cause: Object.assign(new Error('connect ECONNREFUSED 100.64.0.1:8000'), {code: 'ECONNREFUSED'})}); };
  await assert.rejects(triggerDeployment({url:'http://100.64.0.1:8000',token:'private',uuid:'app',sha,fetcher:refused}),
    error => error.message.includes('(ECONNREFUSED)') && !error.message.includes('100.64.0.1'));
  assert.equal(calls,1);
});
