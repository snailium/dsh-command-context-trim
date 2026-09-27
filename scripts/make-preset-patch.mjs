#!/usr/bin/env node
/**
 * Emit a patch overlay that gives a preset-less profile (headless, tui) a
 * compaction-tuned preset and makes it the default for new sessions.
 *
 * The preset plane is inserted by `dsh-web-app` only, so a headless profile has no
 * registry and `/trim preset` cannot run there. Automation still needs the tuned
 * composition, and this is the way in: read a shipped preset file, tune its
 * `compaction-basic` config, write both rows into an overlay, and pass it at boot:
 *
 *   node scripts/make-preset-patch.mjs \
 *     --base <dsh install>/@deepseek-ai/dsh-web-app/presets/standard.patch.yml \
 *     --id standard-tuned --ratio 0.8 --routes fixtures/headless-tuned-preset/routes.json \
 *     --out /tmp/tuned.yml
 *
 *   DSH_HOME=<fresh> dsh --profile headless --patch /tmp/tuned.yml "do the task"
 *
 * Everything it prints and writes is deterministic: no dsh import, no network, no
 * guessing about the live route inventory (routes come from `--routes`).
 *
 * @module dsh-command-context-trim/scripts/make-preset-patch
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FALLBACK_SUMMARIZER_MAX_TOKENS, planCompactionTuning } from '../lib/compaction-spec.js';
import { resolveRouteInventory } from '../lib/dump-routes.js';
import { extractPluginsFromPatch } from '../lib/preset-yaml.js';
import { buildHostTunedPatch, buildTunedPresetPatch } from '../lib/tuned-preset.js';

const USAGE = `usage: make-preset-patch.mjs --base <preset.patch.yml|plugins.yml> [options]

  --base <path>        shipped preset patch (its plugins: list is cloned) or a raw plugin list
  --id <preset-id>     preset identity for the generated row (default: standard-tuned)
  --name <text>        display name (default: the id)
  --description <text> row description
  --order <number>     registry sort order (default: 1.5, i.e. right after standard)
  --ratio <number>     compaction trigger as a fraction of each routed window (default: 0.8)
  --routes <json>      [{provider, model, contextWindow, maxTokens}] — explicit route list
  --dump <file>        a 'dsh --profile <name> --dump-config' output; its llm-pi-ai provider
                       table supplies the window and output reserve per model
  --context-window <n> FALLBACK window, used only when no route could be read
  --max-tokens <n>     FALLBACK output reserve for that same route (default: 0)
  --model <p:m>        name the fallback route; without it no per-route policy can be emitted
  --include-stock-disabled-routes
                              enable a pressure trigger even on routes whose stock profile has none
                              (default: keep them at stock; see the caution in the output)
  --window-agnostic    deliberately tune the ratio alone, needing no window at all
  --summarizer-max-tokens <n>  cap for the compaction call itself (default: 8192)
  --route <p:m>        summarization route for the compaction call
  --registry <mode>    insert (default, for profiles without the registry) or override
  --mode <kind>        preset (default: a preset row + the registry default) or host
                       (write the tuning onto the profile's own compaction-basic row —
                       what headless/tui profiles actually use)
  --out <path>         write here instead of stdout
`;

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? 'preset';
if (!['preset', 'host'].includes(mode)) fail(`--mode must be preset or host, got "${mode}"`);
if (mode === 'preset' && args.base === undefined) fail('--base is required (the preset whose composition is cloned)');
const baseText = args.base === undefined ? undefined : readFileSync(args.base, 'utf8');
const base = baseText === undefined ? undefined : /^ *plugins: *$/mu.test(baseText) ? extractPluginsFromPatch(baseText) : baseText;
if (mode === 'preset' && base === null) fail(`no plugins: list found in ${args.base}`);
const routes = args.routes === undefined ? undefined : JSON.parse(readFileSync(args.routes, 'utf8'));
if (routes !== undefined && !Array.isArray(routes)) fail('--routes must contain a JSON array');
const presetId = args.id ?? 'standard-tuned';
const targetRatio = Number(args.ratio ?? 0.8);
const summarizationRoute = args.route === undefined ? undefined : parseRoute(args.route);
const summarizerMaxTokens = Number(args['summarizer-max-tokens'] ?? FALLBACK_SUMMARIZER_MAX_TOKENS);
let resolved;
try {
	resolved = resolveRouteInventory({
		routes,
		dumpText: args.dump === undefined ? undefined : readFileSync(args.dump, 'utf8'),
		contextWindow: args['context-window'],
		maxTokens: args['max-tokens'],
		model: args.model,
		windowAgnostic: args['window-agnostic'] === true
	});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
// With no route to attach a policy to, the overlay carries the top-level ratio alone —
// still enough to move the trigger everywhere, because a zero headroom lets the ratio (not
// dsh's 65536 default) decide. With a window override in hand the achievable trigger is
// reported for that window, so the operator can see what the numbers mean.
const plan = resolved.routes.length > 0
	? planCompactionTuning({
			routes: resolved.routes,
			targetRatio,
			summarizationRoute,
			includeStockDisabled: args['include-stock-disabled-routes'] === true
		})
	: {
			config: {
				thresholdRatio: targetRatio,
				headroomTokens: 0,
				maxTokens: summarizerMaxTokens,
				...(summarizationRoute === undefined ? {} : { summarizationProvider: summarizationRoute.provider, summarizationModel: summarizationRoute.model })
			},
			notes: [
				`${resolved.source}: thresholdRatio ${targetRatio} applies to every route, with no per-route policies`,
				...(resolved.windowOverride === undefined
					? []
					: [
							`for a ${resolved.windowOverride.contextWindow}-token window with ${resolved.windowOverride.maxTokens} reserved, ` +
								`that trigger is ~${Math.floor(Math.min(resolved.windowOverride.contextWindow * targetRatio, resolved.windowOverride.contextWindow - resolved.windowOverride.maxTokens))} tokens ` +
								`(${((Math.min(resolved.windowOverride.contextWindow * targetRatio, resolved.windowOverride.contextWindow - resolved.windowOverride.maxTokens) / resolved.windowOverride.contextWindow) * 100).toFixed(1)} % of the window)`
						])
			],
			policies: [],
			skipped: []
		};
const { patch } = mode === 'host' ? buildHostTunedPatch({ plan }) : buildTunedPresetPatch({
	base,
	presetId,
	name: args.name,
	description: args.description,
	order: args.order === undefined ? undefined : Number(args.order),
	plan,
	registryMode: args.registry ?? 'insert'
});
if (args.out === undefined) process.stdout.write(patch);
else {
	writeFileSync(args.out, patch);
	process.stderr.write(`wrote ${args.out}\n`);
}
process.stderr.write(`  route source: ${resolved.source}\n`);
for (const note of resolved.notes) process.stderr.write(`  ${note}\n`);
for (const note of plan.notes) process.stderr.write(`  ${note}\n`);
process.stderr.write(
	mode === 'host'
		? '  written onto the profile plane: compaction-basic (headless/tui never resolve a session preset)\n'
		: `  default preset for new sessions: ${presetId} (registry mode: ${args.registry ?? 'insert'})\n`
);

function parseArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(USAGE);
			process.exit(0);
		}
		const key = arg.replace(/^--/u, '');
		if (key === 'window-agnostic' || key === 'include-stock-disabled-routes') {
			out[key] = true;
			continue;
		}
		if (!['base', 'id', 'name', 'description', 'order', 'ratio', 'routes', 'dump', 'context-window', 'max-tokens', 'model', 'route', 'summarizer-max-tokens', 'registry', 'mode', 'out'].includes(key)) fail(`unknown option ${arg}`);
		if (key === 'route') {
			out.route = argv[++index];
			if (out.route === undefined) fail('--route needs provider:model');
			continue;
		}
		out[key] = argv[++index];
		if (out[key] === undefined) fail(`${arg} needs a value`);
	}
	return out;
}

function parseRoute(text) {
	const colon = text.indexOf(':');
	if (colon <= 0 || colon === text.length - 1) fail(`--route must read provider:model, got "${text}"`);
	return { provider: text.slice(0, colon).trim(), model: text.slice(colon + 1).trim() };
}

function fail(message) {
	process.stderr.write(`make-preset-patch: ${message}\n\n${USAGE}`);
	process.exit(2);
}
