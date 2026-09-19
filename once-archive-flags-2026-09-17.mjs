// One-shot, 2026-09-17. Creates the four archive-experiment flags for the 5 October talk
// (demo-plans/2026-09-15-plan-2-delete-experiment.md §5 and §10). This is not tooling and not a
// scenario step: these flags are deliberately OUTSIDE scenario/flags.json, because the catalog is
// asserted at exactly 24 and these four must never be reconciled, counted, or archive-checked by
// the engine. Nothing else in the repository reads them.
//
//   node once-archive-flags-2026-09-17.mjs                                 dry run, no writes
//   node once-archive-flags-2026-09-17.mjs --client-side-id                 print one public ID
//   node once-archive-flags-2026-09-17.mjs --pilot <flag> --confirm <proj>  one flag
//   node once-archive-flags-2026-09-17.mjs --apply --confirm <project>      every missing flag
//
// Re-runs are safe: every flag is read first, and only what is missing or differing is written.
//
// Do NOT run `node demo.mjs bootstrap` while these exist. It refuses on any project flag absent
// from the catalog, and these are four such flags (it already refuses on oleksii-starter-chatbot).
import fs from 'node:fs';
import { LD, request, settingsFor, tokensFor, requireConfirmation, loadScenario, targetingInstructions, redact } from './lib.mjs';

const SEMANTIC_PATCH = 'application/json; domain-model=launchdarkly.semanticpatch';
const MAINTAINER_FIRST_NAME = 'Oleksii';
const TAG = 'stage-experiment';
const SERVING_ENVIRONMENTS = ['production', 'staging'];
const COMMENT = 'Archive-experiment flags for the 2026-10-05 talk, created 2026-09-17. Outside the scenario catalog by design.';

// All four are boolean, temporary, available to client-side SDKs, and serve true in both critical
// environments. The description is what the room reads on screen, so it names the real fallback.
const TARGET = {
  'demo-order-archive-object-storage': {
    name: 'Order archive object storage',
    description: 'Order archive target: object storage (true) or disk array arch-array-01 (false)',
    role: 'STAGE - carries the evaluation history that deletion destroys'
  },
  'demo-invoice-archive-object-storage': {
    name: 'Invoice archive object storage',
    description: 'Invoice archive target: object storage (true) or disk array arch-array-01 (false)',
    role: 'RESERVE - only if the stage flag is lost before the talk'
  },
  'demo-archive-rehearsal': {
    name: 'Archive rehearsal',
    description: 'Rehearsal target for the archive and delete experiment.',
    role: 'REHEARSAL outer - every rehearsal runs here, never on the stage flag'
  },
  'demo-archive-array-failover': {
    name: 'Archive array failover',
    description: 'Failover to disk array arch-array-07. Evaluated only when the object-storage flag serves false.',
    role: 'TIME BOMB inner - must stay never evaluated until the talk'
  },
  'demo-archive-rehearsal-failover': {
    name: 'Archive rehearsal failover',
    description: 'Failover to disk array arch-array-07, for rehearsals only.',
    role: 'REHEARSAL inner - deleted and recreated at every rehearsal'
  }
};

const SAFE_DEMO_KEY = /^demo-[a-z0-9]+(-[a-z0-9]+)*$/;

function loadEnv() {
  if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  return process.env;
}
const argumentAfter = (name) => { const index = process.argv.indexOf(name); return index > 1 ? process.argv[index + 1] : undefined; };

// The guard that matters: this script must never be able to touch a catalog flag. Deleting or
// recreating one destroys history the talk depends on and breaks the exactly-24 assertion.
function assertOutsideCatalog(catalogKeys) {
  for (const key of Object.keys(TARGET)) {
    if (!SAFE_DEMO_KEY.test(key)) throw new Error(`Refusing an unsafe flag key: ${key}`);
    if (catalogKeys.includes(key)) throw new Error(`Refusing ${key}: it is a catalog flag. This script only creates flags outside scenario/flags.json.`);
  }
}

const env = loadEnv();
const secrets = ['GH_RESET_TOKEN', 'GH_DEMO_TOKEN', 'LD_RESET_TOKEN', 'LD_DEMO_TOKEN'].map((name) => env[name]).filter(Boolean);
try {
  const settings = settingsFor(env);
  const pilot = argumentAfter('--pilot');
  const apply = process.argv.includes('--apply');
  const wantsClientSideId = process.argv.includes('--client-side-id');
  if (pilot && apply) throw new Error('Use either --pilot <flag> or --apply, not both.');
  if (pilot && !TARGET[pilot]) throw new Error(`Pilot flag ${pilot} is not one of the four archive-experiment flags.`);
  const writing = Boolean(pilot || apply);
  if (writing) requireConfirmation(argumentAfter('--confirm'), settings.project);

  assertOutsideCatalog(loadScenario(process.cwd()).catalog.flags.map((flag) => flag.key));

  // Reads use the read-only token; only an actual write reaches for the reset token.
  const readToken = tokensFor('scenario', env).LD_DEMO_TOKEN;

  // The client-side ID is public by design and belongs in the published page. The environment's
  // apiKey and mobileKey are NOT, so only the client-side ID is ever printed here. In LaunchDarkly
  // the JS SDK's client-side ID is the environment's own _id.
  if (wantsClientSideId) {
    const environment = await request(fetch, LD, `/api/v2/projects/${settings.project}/environments/production`, readToken);
    const clientSideId = environment._id;
    if (clientSideId) console.log(`Production client-side ID: ${clientSideId}`);
    else console.log(`No _id on the environment. Fields present (names only): ${Object.keys(environment).sort().join(', ')}`);
  } else {

  // Answers plan 2 §6's NEEDS TEST for free: what the project default actually is, before we override it.
  const project = await request(fetch, LD, `/api/v2/projects/${settings.project}`, readToken);
  const projectDefault = project.defaultClientSideAvailability || null;
  console.log(`Project default client-side availability: ${projectDefault ? `usingEnvironmentId=${projectDefault.usingEnvironmentId}, usingMobileKey=${projectDefault.usingMobileKey}` : 'not reported by the API'}`);
  console.log('  (Variant D step 3 depends on this: if the default is off, a recreated flag is invisible to the page and it stays red.)');
  console.log('');

  const listed = await request(fetch, LD, `/api/v2/flags/${settings.project}?limit=100`, readToken);
  const existing = new Map((Array.isArray(listed.items) ? listed.items : []).map((item) => [item.key, item]));

  const members = await request(fetch, LD, '/api/v2/members?limit=50', readToken);
  const matches = (members.items || []).filter((member) => member.firstName === MAINTAINER_FIRST_NAME && !member._pendingInvite);
  if (matches.length !== 1) throw new Error(`Expected exactly one active member named ${MAINTAINER_FIRST_NAME}; found ${matches.length}.`);
  const maintainer = matches[0];

  const keys = pilot ? [pilot] : Object.keys(TARGET);
  const plan = keys.map((key) => ({ key, present: existing.get(key) || null }));

  console.log('FLAG | STATE | ROLE');
  for (const { key, present } of plan) {
    console.log(`${key} | ${present ? `exists, created ${String(present.creationDate ? new Date(present.creationDate).toISOString().slice(0, 10) : 'unknown')}` : 'ABSENT, would create'} | ${TARGET[key].role}`);
  }
  console.log('');
  console.log(`Settings for every flag: boolean (true/false), temporary, clientSideAvailability usingEnvironmentId=true, tag "${TAG}", maintainer ${maintainer.firstName}, on and serving true in ${SERVING_ENVIRONMENTS.join(' and ')}.`);

  const pending = plan.filter((item) => !item.present);
  if (!writing) {
    console.log('');
    console.log(`Dry run: ${pending.length} of ${plan.length} flag(s) would be created. Nothing was written.`);
    console.log('To apply:  node once-archive-flags-2026-09-17.mjs --apply --confirm ' + settings.project);
  } else {
    const writeToken = tokensFor('bootstrap', env).LD_RESET_TOKEN;
    console.log('');
    for (const { key } of pending) {
      const target = TARGET[key];
      const created = await request(fetch, LD, `/api/v2/flags/${settings.project}`, writeToken, {
        method: 'POST',
        body: JSON.stringify({
          key,
          name: target.name,
          description: target.description,
          temporary: true,
          tags: [TAG],
          variations: [{ value: true }, { value: false }],
          clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: false }
        })
      });
      console.log(`Created ${key}.`);

      // Reuse the scenario engine's own targeting shape: on, fallthrough true, no cluster rules.
      for (const environmentKey of SERVING_ENVIRONMENTS) {
        await request(fetch, LD, `/api/v2/flags/${settings.project}/${key}`, writeToken, {
          method: 'PATCH',
          headers: { 'Content-Type': SEMANTIC_PATCH },
          body: JSON.stringify({ environmentKey, comment: COMMENT, instructions: targetingInstructions({ state: 'on', serve: 'true', clusters: [] }, created) })
        });
        console.log(`  ${environmentKey}: on, serving true.`);
      }

      await request(fetch, LD, `/api/v2/flags/${settings.project}/${key}`, writeToken, {
        method: 'PATCH',
        headers: { 'Content-Type': SEMANTIC_PATCH },
        body: JSON.stringify({ comment: COMMENT, instructions: [{ kind: 'updateMaintainerMember', value: maintainer._id }] })
      });
      console.log(`  maintainer: ${maintainer.firstName}.`);
    }
    console.log('');
    console.log(`${pilot ? 'Pilot' : 'Apply'}: ${pending.length} flag(s) created, ${plan.length - pending.length} already present.`);
    console.log('Reminder: demo-archive-array-failover must stay NEVER evaluated until the talk, so the page may only read it inside the disk-array branch.');
  }
  }
} catch (error) {
  console.error(`Error: ${redact(error, secrets)}`);
  process.exitCode = 1;
}
