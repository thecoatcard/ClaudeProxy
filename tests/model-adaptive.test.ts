import { strict as assert } from 'node:assert';

import { getCapabilityProfile } from '../lib/models/capability-profile';
import { getAdaptiveLoopPolicy } from '../lib/transformers/adaptive-loop-policy';
import { getAdaptiveCompactionPolicy } from '../lib/transformers/adaptive-compaction-policy';
import { getAdaptiveGuidancePolicy, buildAdaptiveBehaviorReminder } from '../lib/transformers/adaptive-guidance';
import { recoverActionText } from '../lib/transformers/action-recovery';
import { shouldRecoverActionText } from '../lib/transformers/adaptive-action-policy';
import { detectFailureLoop } from '../lib/transformers/loop-detector';

function makeLoopMessages(count: number) {
  const messages: any[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'write_file', input: { path: 'src/app.ts' } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true, content: 'ENOENT: no such file or directory' }],
    });
  }
  return messages;
}

describe('model adaptive policies', () => {
  it('selects stronger profile for gemini-2.5-flash than gemma-4-26b-a4b-it', () => {
    const strong = getCapabilityProfile('gemini-2.5-flash');
    const weak = getCapabilityProfile('gemma-4-26b-a4b-it');

    assert.ok(strong.scores.tool_adherence > weak.scores.tool_adherence);
    assert.ok(strong.scores.context_retention > weak.scores.context_retention);
  });

  it('uses lighter loop threshold for weak tool models and higher threshold for strong ones', () => {
    assert.equal(getAdaptiveLoopPolicy('gemini-2.5-flash').minRepeats, 3);
    assert.equal(getAdaptiveLoopPolicy('gemini-flash-lite-latest').minRepeats, 2);
  });

  it('loop detector respects model-adaptive thresholds', () => {
    const twoFailures = makeLoopMessages(2);
    const threeFailures = makeLoopMessages(3);

    assert.equal(detectFailureLoop(twoFailures, 'gemini-2.5-flash').detected, false);
    assert.equal(detectFailureLoop(threeFailures, 'gemini-2.5-flash').detected, true);
    assert.equal(detectFailureLoop(twoFailures, 'gemma-4-31b-it').detected, true);
  });

  it('compaction policy compacts later for stronger context models', () => {
    const strong = getAdaptiveCompactionPolicy('gemini-2.5-flash', 90000, 20, 3000);
    const weak = getAdaptiveCompactionPolicy('gemma-4-26b-a4b-it', 90000, 20, 3000);

    assert.ok(strong.maxTokensApprox > weak.maxTokensApprox);
    assert.ok(weak.keepLastN > strong.keepLastN);
    assert.ok(weak.failureAnchorDepth > strong.failureAnchorDepth);
  });

  it('guidance strength is lighter for strong models and stronger for weak ones', () => {
    assert.equal(getAdaptiveGuidancePolicy('gemini-2.5-flash').strength, 'light');
    assert.equal(getAdaptiveGuidancePolicy('gemma-4-31b-it').strength, 'strong');

    const strongReminder = buildAdaptiveBehaviorReminder('gemini-2.5-flash', true);
    const weakReminder = buildAdaptiveBehaviorReminder('gemma-4-31b-it', true);

    assert.ok(strongReminder.length < weakReminder.length);
    assert.ok(weakReminder.includes('POLICY'));
  });

  it('action recovery policy is aggressive for weaker models and minimal for stronger ones', () => {
    const text = 'prefix with context [Action: I am calling tool bash with arguments: {"command":"pwd"}] suffix with more context';
    const recovered = recoverActionText(text);
    assert.ok(recovered);

    assert.equal(shouldRecoverActionText('gemma-4-31b-it', text, recovered!), true);
    assert.equal(shouldRecoverActionText('gemini-2.5-flash', text, recovered!), false);
  });
});
