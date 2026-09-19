// One-shot probe, 2026-09-17. Answers the question plan 2 §3 carries as NEEDS TEST:
// "Whether a deleted key can be created again" (Story 01 says it happened; LaunchDarkly does not
// document it). This is not tooling and not a scenario step.
//
//   node once-delete-recreate-probe-2026-09-17.mjs                        dry run, describes the cycle
//   node once-delete-recreate-probe-2026-09-17.mjs --run --confirm <proj>  create, archive, delete, recreate, clean up
//
// It uses one disposable key of its own and never touches the catalog or the three
// archive-experiment flags. It leaves the project exactly as it found it.
import fs from 'node:fs';
import { LD, request, settingsFor, tokensFor, requireConfirmation, loadScenario, redact } from './lib.mjs';

const SEMANTIC_PATCH = 'application/json; domain-model=launchdarkly.semanticpatch';
const JSON_PATCH = 'application/json';
const PROBE_KEY = 'demo-archive-delete-probe';

function loadEnv() {
  if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  return process.env;
}
const argumentAfter = (name) => { const index = process.argv.indexOf(name); return index > 1 ? process.argv[index + 1] : undefined; };

const body = (key) => JSON.stringify({
  key,
  name: 'Archive delete probe',
  description: 'Disposable probe for whether a deleted flag key can be created again.',
  temporary: true,
  tags: ['stage-experiment'],
  variations: [{ value: true }, { value: false }],
  clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: false }
});

async function exists(fetcher, project, token, key) {
  try {
    const flag = await request(fetcher, LD, `/api/v2/flags/${project}/${key}`, token);
    return { present: true, archived: Boolean(flag.archived), createdAt: flag.creationDate ? new Date(flag.creationDate).toISOString() : null };
  } catch (error) {
    return { present: false, why: error.message.slice(0, 120) };
  }
}

async function archive(fetcher, project, token, key) {
  try {
    await request(fetcher, LD, `/api/v2/flags/${project}/${key}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': SEMANTIC_PATCH },
      body: JSON.stringify({ comment: 'Probe: archive before delete.', instructions: [{ kind: 'archiveFlag' }] })
    });
    return 'semantic patch archiveFlag';
  } catch {
    await request(fetcher, LD, `/api/v2/flags/${project}/${key}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': JSON_PATCH },
      body: JSON.stringify([{ op: 'replace', path: '/archived', value: true }])
    });
    return 'json patch /archived';
  }
}

const env = loadEnv();
const secrets = ['GH_RESET_TOKEN', 'GH_DEMO_TOKEN', 'LD_RESET_TOKEN', 'LD_DEMO_TOKEN'].map((name) => env[name]).filter(Boolean);
try {
  const settings = settingsFor(env);
  const run = process.argv.includes('--run');
  if (run) requireConfirmation(argumentAfter('--confirm'), settings.project);

  const catalogKeys = loadScenario(process.cwd()).catalog.flags.map((flag) => flag.key);
  if (catalogKeys.includes(PROBE_KEY)) throw new Error(`Refusing: ${PROBE_KEY} is a catalog flag.`);

  const readToken = tokensFor('scenario', env).LD_DEMO_TOKEN;
  console.log(`Probe key: ${PROBE_KEY} (disposable, outside the catalog)`);
  console.log('Cycle: create -> archive -> delete -> recreate under the SAME key -> archive -> delete');
  console.log('');

  if (!run) {
    const state = await exists(fetch, settings.project, readToken, PROBE_KEY);
    console.log(`Current state: ${state.present ? `present, archived=${state.archived}` : 'absent'}`);
    console.log('Dry run. Nothing was written.');
    console.log(`To run:  node once-delete-recreate-probe-2026-09-17.mjs --run --confirm ${settings.project}`);
  } else {
    const t = tokensFor('bootstrap', env).LD_RESET_TOKEN;
    const p = settings.project;

    const first = await request(fetch, LD, `/api/v2/flags/${p}`, t, { method: 'POST', body: body(PROBE_KEY) });
    const firstCreated = new Date(first.creationDate).toISOString();
    console.log(`1. created            -> ok, creationDate ${firstCreated}`);

    console.log(`2. archived           -> ${await archive(fetch, p, t, PROBE_KEY)}`);
    console.log(`   readback           -> archived=${(await exists(fetch, p, readToken, PROBE_KEY)).archived}`);

    await request(fetch, LD, `/api/v2/flags/${p}/${PROBE_KEY}`, t, { method: 'DELETE' });
    const afterDelete = await exists(fetch, p, readToken, PROBE_KEY);
    console.log(`3. deleted            -> gone=${!afterDelete.present}`);

    let recreated = null;
    try {
      recreated = await request(fetch, LD, `/api/v2/flags/${p}`, t, { method: 'POST', body: body(PROBE_KEY) });
      console.log(`4. RECREATED same key -> YES, creationDate ${new Date(recreated.creationDate).toISOString()}`);
      console.log(`   is it a new flag?  -> creationDate moved: ${new Date(recreated.creationDate).toISOString() !== firstCreated}`);
    } catch (error) {
      console.log(`4. RECREATED same key -> NO. ${redact(error, secrets).slice(0, 200)}`);
    }

    if (recreated) {
      await archive(fetch, p, t, PROBE_KEY);
      await request(fetch, LD, `/api/v2/flags/${p}/${PROBE_KEY}`, t, { method: 'DELETE' });
      const final = await exists(fetch, p, readToken, PROBE_KEY);
      console.log(`5. cleaned up         -> gone=${!final.present} (a second delete on the same key also worked)`);
    }

    console.log('');
    console.log(recreated
      ? 'ANSWER: a deleted key CAN be created again. Variant D is repeatable on the rehearsal flag.'
      : 'ANSWER: a deleted key CANNOT be created again. Each Variant D needs a fresh key.');
  }
} catch (error) {
  console.error(`Error: ${redact(error, secrets)}`);
  process.exitCode = 1;
}
