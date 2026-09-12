// One-shot, 2026-09-12. Background realism for the talk sandbox: a maintainer only on the protected
// pair, none on the other 22 catalog flags, and a slightly messy tag picture applied once. This is not
// tooling and not a scenario step; nothing else in the repository reads maintainers or tags.
//
//   node once-flag-metadata-2026-09-12.mjs                                    dry run, no writes
//   node once-flag-metadata-2026-09-12.mjs --pilot <flag> --confirm <project>  one flag
//   node once-flag-metadata-2026-09-12.mjs --apply --confirm <project>         every flag still differing
//
// Re-runs are safe: each flag is read first and only the difference is patched.
import fs from 'node:fs';
import { LD, request, settingsFor, tokensFor, requireConfirmation, loadScenario } from './lib.mjs';

const SEMANTIC_PATCH = 'application/json; domain-model=launchdarkly.semanticpatch';
const MAINTAINER_FIRST_NAME = 'Oleksii';
const COMMENT = 'One-time background metadata for the talk sandbox, 2026-09-12: maintainers on the protected pair only, slightly messy tags.';

// The mess is deliberate: spelling variants of the same area, a stale launch tag, the old initiative
// tag kept on only some flags, and five flags with no tags at all.
const TARGET = {
  'demo-checkout-rollout': { tags: ['checkout', 'release'] },
  'demo-cart-v2': { tags: ['checkout-team'] },
  'demo-checkout-address-validation': { tags: ['team-checkout', 'campaign-2026-08-16'] },
  'demo-legacy-profile': { tags: [] },
  'demo-identity-passkeys': { tags: ['identity', 'release'] },
  'demo-profile-preferences': { tags: ['identity', 'campaign-2026-08-16'], maintained: true },
  'demo-retired-banner': { tags: [] },
  'demo-personalized-home': { tags: ['growth', 'experiment'] },
  'demo-storefront-navigation': { tags: ['growth-team'] },
  'demo-search-ranking-v3': { tags: ['search', 'q2-launch'] },
  'demo-inventory-reservation': { tags: ['fulfilment', 'campaign-2026-08-16'] },
  'demo-shipping-estimates': { tags: ['fulfillment'] },
  'demo-express-returns': { tags: ['fulfilment', 'release'], maintained: true },
  'demo-pricing-engine-v2': { tags: ['pricing', 'campaign-2026-08-16'] },
  'demo-tax-calculation-v2': { tags: [] },
  'demo-payment-retry': { tags: ['payments', 'do-not-delete'] },
  'demo-fraud-screening': { tags: ['payment'] },
  'demo-email-notifications-v2': { tags: ['notifications', 'campaign-2026-08-16'] },
  'demo-sms-notifications': { tags: [] },
  'demo-subscription-pause': { tags: ['subscriptions'] },
  'demo-support-assistant': { tags: [] },
  'demo-catalog-enrichment': { tags: ['catalog', 'campaign-2026-08-16'] },
  'demo-order-history-v2': { tags: ['orders', 'release'] },
  'demo-recommendation-model-v2': { tags: ['recs', 'experiment'] }
};

function loadEnv() {
  if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  return process.env;
}
const argumentAfter = (name) => { const index = process.argv.indexOf(name); return index > 1 ? process.argv[index + 1] : undefined; };

function assertTarget(catalogKeys) {
  const keys = Object.keys(TARGET);
  const missing = catalogKeys.filter((key) => !TARGET[key]);
  const extra = keys.filter((key) => !catalogKeys.includes(key));
  if (missing.length || extra.length) throw new Error(`The target map must cover exactly the ${catalogKeys.length} catalog flags. Missing: ${missing.join(', ') || 'none'}. Not in the catalog: ${extra.join(', ') || 'none'}.`);
  const maintained = keys.filter((key) => TARGET[key].maintained);
  if (maintained.length !== 2) throw new Error(`Exactly 2 flags keep a maintainer; the map declares ${maintained.length}.`);
  for (const key of keys) {
    const tags = TARGET[key].tags;
    if (new Set(tags).size !== tags.length) throw new Error(`${key} lists a tag twice.`);
    for (const tag of tags) if (!/^[a-z0-9-]+$/.test(tag)) throw new Error(`${key} has a tag outside lowercase letters, digits and hyphens: ${tag}`);
  }
}

// Only the difference between the flag as it stands and the target becomes an instruction, so a flag
// already matching produces none and is skipped.
function instructionsFor(flag, target, memberId) {
  const instructions = [];
  const current = flag.maintainerId ?? flag._maintainer?._id ?? null;
  if (target.maintained) { if (current !== memberId) instructions.push({ kind: 'updateMaintainerMember', value: memberId }); }
  else if (current) instructions.push({ kind: 'removeMaintainer' });
  const have = new Set(flag.tags || []); const want = new Set(target.tags);
  const remove = [...have].filter((tag) => !want.has(tag)).sort();
  const add = [...want].filter((tag) => !have.has(tag)).sort();
  if (remove.length) instructions.push({ kind: 'removeTags', values: remove });
  if (add.length) instructions.push({ kind: 'addTags', values: add });
  return instructions;
}

const env = loadEnv();
try {
  const settings = settingsFor(env);
  const pilot = argumentAfter('--pilot');
  const apply = process.argv.includes('--apply');
  if (pilot && apply) throw new Error('Use either --pilot <flag> or --apply, not both.');
  const writing = Boolean(pilot || apply);
  if (writing) requireConfirmation(argumentAfter('--confirm'), settings.project);

  const catalogKeys = loadScenario(process.cwd()).catalog.flags.map((flag) => flag.key);
  assertTarget(catalogKeys);
  if (pilot && !TARGET[pilot]) throw new Error(`Pilot flag ${pilot} is not in the catalog.`);

  // Reads use the read-only token; only an actual write reaches for the reset token.
  const readToken = tokensFor('scenario', env).LD_DEMO_TOKEN;
  const members = await request(fetch, LD, '/api/v2/members?limit=50', readToken);
  const matches = (members.items || []).filter((member) => member.firstName === MAINTAINER_FIRST_NAME && !member._pendingInvite);
  if (matches.length !== 1) throw new Error(`Expected exactly one active member named ${MAINTAINER_FIRST_NAME}; found ${matches.length}.`);
  const maintainer = matches[0];
  console.log(`Maintainer for the protected pair: ${maintainer.firstName}, ${maintainer.role}.`);

  const keys = pilot ? [pilot] : catalogKeys;
  const plan = [];
  for (const key of keys) {
    const flag = await request(fetch, LD, `/api/v2/flags/${settings.project}/${key}`, readToken);
    plan.push({ key, flag, instructions: instructionsFor(flag, TARGET[key], maintainer._id) });
  }

  console.log('FLAG | MAINTAINER BEFORE -> AFTER | TAGS BEFORE -> AFTER | CHANGES');
  for (const { key, flag, instructions } of plan) {
    const before = flag._maintainer?.firstName || (flag.maintainerId ? 'member' : 'none');
    const after = TARGET[key].maintained ? maintainer.firstName : 'none';
    console.log(`${key} | ${before} -> ${after} | [${(flag.tags || []).join(', ')}] -> [${TARGET[key].tags.join(', ')}] | ${instructions.length ? instructions.map((item) => item.kind).join(', ') : 'already matches'}`);
  }

  const pending = plan.filter((item) => item.instructions.length);
  if (!writing) {
    console.log(`Dry run: ${pending.length} of ${plan.length} flag(s) would change. Nothing was written.`);
  } else {
    const writeToken = tokensFor('bootstrap', env).LD_RESET_TOKEN;
    for (const { key, instructions } of pending) {
      await request(fetch, LD, `/api/v2/flags/${settings.project}/${key}`, writeToken, {
        method: 'PATCH',
        headers: { 'Content-Type': SEMANTIC_PATCH },
        body: JSON.stringify({ comment: COMMENT, instructions })
      });
      console.log(`Patched ${key}: ${instructions.map((item) => item.kind).join(', ')}.`);
    }
    console.log(`${pilot ? 'Pilot' : 'Apply'}: ${pending.length} flag(s) patched, ${plan.length - pending.length} already matched.`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
