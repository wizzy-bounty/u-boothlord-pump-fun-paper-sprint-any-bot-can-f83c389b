// Pump.fun Paper Sprint bot (boothlord): a tape-gated bonding-curve strategy for the
// agent-fun/replay/v2 harness. The grader runs `node /bot/main.ts` on Node 22; this entrypoint
// only wires the vendored SDK shim to the strategy in strategy.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
