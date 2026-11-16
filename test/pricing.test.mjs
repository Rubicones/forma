import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeCost, codexCost} from '../pricing.mjs';

test('Codex prices cached input once and keeps ambiguous usage unknown', () => {
  const usage = {input_tokens:127262, cached_input_tokens:96640, output_tokens:7135};
  assert.ok(Math.abs(codexCost('gpt-6-astra', usage) - 0.75961) < 1e-10);
  assert.equal(codexCost('gpt-6.1-sol', {input_tokens:10000, cached_input_tokens:5000, output_tokens:1000}), 0.0205);
  assert.equal(codexCost('gpt-6-astra', {...usage, input_tokens:300000}), null);
  assert.equal(codexCost('gpt-6-astra', {}), null);
});

test('Claude uses SDK pricing and prices hour writes separately on fallback', () => {
  assert.equal(claudeCost({modelUsage:{'claude-opus-5-5':{costUSD:0.123}}}), 0.123);
  const usage = {input_tokens:0, output_tokens:0, cache_creation_input_tokens:1000000,
    cache_creation:{ephemeral_1h_input_tokens:500000}};
  assert.equal(claudeCost({usage}, 'claude-opus-5-5'), 6.5);
});
