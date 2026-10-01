/**
 * The compaction-tuning half's module entry.
 *
 * A row's **heading** on the Plugins page comes from its module, and dsh resolves a row's `meta` by module name too
 * (`metaOf(row.name, base)`). Two rows on one module therefore share one heading and one description source, which is
 * why both read "dsh-command-context-trim" until this entry existed. A bundle may declare several rows; giving this one
 * its own module specifier is what makes it identifiable in the UI. The official bundles do the same thing
 * (`@deepseek-ai/dsh-agent/invariant` is a subpath entry).
 *
 * There is no second implementation: the same module answers both rows, and the `role` in the row's config decides which
 * half of it runs — the trims and `/trim`, or the compaction tuning and `/context-tune`. See `./index.js`.
 *
 * The row that points here is declared in `./cordis.patch.yml`, in the SAME `- insert:` block as the trims: a bundle
 * mounts exactly one patch file, so a second file would never be read.
 *
 * @module dsh-command-context-trim/tune
 */
export { name, inject, Config, apply } from './index.js';
