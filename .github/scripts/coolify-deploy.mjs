export function eligibleCommit({sha, latestSha, runs}) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || sha !== latestSha || runs.length !== 2) return false;
  return runs.every(list => {
    const latest = list.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push')
      .sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    return latest?.status === 'completed' && latest.conclusion === 'success';
  });
}

export async function triggerDeployment({url, token, uuid, sha, fetcher=fetch}) {
  const target = new URL(url);
  const tailscale = /^100\.(\d+)\.\d+\.\d+$/.exec(target.hostname);
  const privateHost = ['localhost','127.0.0.1','[::1]'].includes(target.hostname) || (tailscale && +tailscale[1]>=64 && +tailscale[1]<=127);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || (target.protocol==='http:' && !privateHost)) {
    throw new Error('Use HTTPS ou o endereço privado do Coolify.');
  }
  if (!token || !/^[a-zA-Z0-9_-]+$/.test(uuid || '') || !/^[a-f0-9]{40}$/.test(sha || '')) {
    throw new Error('Token, UUID ou commit do deploy ausente/inválido.');
  }
  const base = target.href.replace(/\/$/, '') + '/api/v1';
  async function request(method,path,data) {
    let response;
    try {
      response=await fetcher(base+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    } catch (error) {
      // Só o código da falha (ECONNREFUSED, timeout, redirecionamento...): nunca o endereço.
      const cause = error?.cause?.code || error?.cause?.name || error?.name || 'desconhecida';
      throw new Error(`Não foi possível conectar à API privada do Coolify (${cause}). Confira COOLIFY_URL (http://IP:8000) e a regra tcp:8000 no Tailscale.`);
    }
    if (!response.ok) throw new Error(`Coolify retornou HTTP ${response.status}.`);
    return response.json();
  }
  const history=await request('GET',`/deployments/applications/${uuid}?take=30`);
  if (history.deployments?.some(job => job.commit===sha && ['queued','in_progress','finished'].includes(job.status))) return null;
  await request('PATCH',`/applications/${uuid}`,{git_commit_sha:sha});
  const deployment=await request('POST',`/applications/${uuid}/start`,{});
  if (!deployment.deployment_uuid) throw new Error('Coolify não informou o identificador do deploy.');
  return deployment.deployment_uuid;
}
