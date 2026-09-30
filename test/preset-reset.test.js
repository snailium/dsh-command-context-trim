import assert from 'node:assert/strict';
import test from 'node:test';

import { findMarkerBlocks, ourPresetBlocks, withoutBlocks } from '../lib/preset-reset.js';

/** A patch shaped like the one `persistBlock` actually writes, with a neighbour's block below ours. */
const PATCH = `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      mock: {}
# >>> dsh-command-context-trim: preset-standard (generated; delete this block to drop the preset) >>>
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    plugins:
      - id: compaction-basic
        config:
          thresholdRatio: 0.8
# <<< dsh-command-context-trim: preset-standard <<<
# >>> someone-else: preset-other >>>

- id: preset-other
  config: {}
# <<< someone-else: preset-other <<<
`;

/** In place: the row shadows the base preset's own row under the SAME id. */
const INPLACE_PATCH = `- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    plugins:
      - id: compaction-basic
        config:
          thresholdRatio: 0.55
# >>> dsh-command-context-trim: preset-standard (generated; delete this block to drop the preset) >>>
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    plugins:
      - id: compaction-basic
        config:
          thresholdRatio: 0.8
# <<< dsh-command-context-trim: preset-standard <<<
`;

test('a block is found by its marker, and only ours is claimed as ours', () => {
	const all = findMarkerBlocks(PATCH);
	assert.equal(all.length, 2, 'both marker blocks are visible');
	assert.deepEqual(all.map((block) => block.rowId), ['preset-standard', 'preset-other']);
	assert.equal(all[0].ourNamespace, true);
	assert.equal(all[1].ourNamespace, false, "another tool's block is not ours to delete");

	const mine = ourPresetBlocks(PATCH);
	assert.deepEqual(mine.map((block) => block.rowId), ['preset-standard']);
});

test('ourPresetBlocks can be narrowed to one row', () => {
	assert.deepEqual(ourPresetBlocks(PATCH, 'preset-standard').map((b) => b.rowId), ['preset-standard']);
	assert.deepEqual(ourPresetBlocks(PATCH, 'preset-nonexistent'), []);
});

test('removing our block leaves the rest of the patch byte-identical', () => {
	const after = withoutBlocks(PATCH, ourPresetBlocks(PATCH));
	assert.equal(after.includes('dsh-command-context-trim'), false, 'our block is gone');
	assert.equal(after.includes('preset-other'), true, "someone else's block survives");
	assert.equal(after.includes('llm-pi-ai'), true, 'unrelated rows survive');
	assert.equal(after.includes('mock: {}'), true);
});

test('an in place override is undone the same way — the base row is what is left', () => {
	// The shipped preset's own row sits UNDER our block with the same id; dropping ours is what restores it.
	const after = withoutBlocks(INPLACE_PATCH, ourPresetBlocks(INPLACE_PATCH));
	assert.equal(after.includes('0.55'), true, "the preset's own threshold is back");
	assert.equal(after.includes('0.8'), false, 'our tuned threshold is gone');
	assert.equal(after.trim().endsWith('thresholdRatio: 0.55'), true);
});

test('a patch with no markers is returned untouched', () => {
	const plain = '- id: llm-pi-ai\n  config: {}\n';
	assert.deepEqual(ourPresetBlocks(plain), []);
	assert.equal(withoutBlocks(plain, ourPresetBlocks(plain)), plain.trim());
});

test('removing every block of a multi-preset patch clears them all', () => {
	const two = PATCH + PATCH.split('\n').slice(1).join('\n');   // the same block twice, second one shifted
	const blocks = ourPresetBlocks(two);
	assert.equal(blocks.length, 2, 'both copies are found');
	const after = withoutBlocks(two, blocks);
	assert.equal(after.includes('dsh-command-context-trim'), false);
});
