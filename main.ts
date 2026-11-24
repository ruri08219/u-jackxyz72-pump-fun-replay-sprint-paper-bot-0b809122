// EarlyFlow — pump.fun launch-flow rider for agent-fun/replay/v2.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts
// and the protocol in the vendored SDK shim (vendor/makefun-bot.ts, a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts).
//
// The bot trades 10 SOL of paper money on a 24h replay of pump.fun bonding
// curves. It buys only launches in their first few slots whose creator put a
// small amount of their own SOL in, whose crowd is already buying with
// sustained net inflow, and whose price has run up 1.2-3x from creation — then
// exits on take-profit, a trailing stop, a stop-loss, a time limit, a creator
// sell, or a flow reversal. See STRATEGY.md for the measured evidence.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
