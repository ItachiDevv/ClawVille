import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('the exported clean subpath imports without dotenv, database, provider, or network effects', async () => {
  const root = resolve(import.meta.dir, '../../../..');
  const evidence = resolve(root, '.brainchain-work');
  await mkdir(evidence, { recursive: true });
  const cwd = await mkdtemp(resolve(evidence, 'isolated-import-'));
  await writeFile(resolve(cwd, '.env'), 'CLAWVILLE_ISOLATED_DOTENV_CANARY=must-not-load\n');
  await writeFile(resolve(cwd, '.env.local'), 'CLAWVILLE_ISOLATED_DOTENV_LOCAL_CANARY=must-not-load\n');
  const script = `
    import { isDeepStrictEqual } from 'node:util';
    const before = {...process.env}; let network = 0;
    globalThis.fetch = async () => { network++; throw new Error('blocked network'); };
    Bun.plugin({name:'reject-platform-imports',setup(builder){
      builder.onResolve({filter:/(?:@clawville\\/database|@elizaos\\/plugin-sql|inference-config|own-ai-provider|openai-(?:text|embedding)-provider|clawville-plugin)/},()=>{throw new Error('forbidden platform import');});
    }});
    const clean = await import(import.meta.resolve('@clawville/agent-runtime/isolated-task', ${JSON.stringify(resolve(root, 'apps/api/index.ts'))}));
    if(typeof clean.createElizaRuntime !== 'function' || network || !isDeepStrictEqual(before,{...process.env})) throw new Error('import side effect');
    if(process.env.CLAWVILLE_ISOLATED_DOTENV_CANARY || process.env.CLAWVILLE_ISOLATED_DOTENV_LOCAL_CANARY) throw new Error('dotenv import');
    console.log('isolated-import-ok');
  `;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', script], {
    cwd, env: { ...process.env, NODE_ENV: 'test', CLAWVILLE_ISOLATED_DOTENV_CANARY: undefined, CLAWVILLE_ISOLATED_DOTENV_LOCAL_CANARY: undefined },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
    expect(output.trim()).toBe('isolated-import-ok');
  } finally { clearTimeout(timer); }
});
