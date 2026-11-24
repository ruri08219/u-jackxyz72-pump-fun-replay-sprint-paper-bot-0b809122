// EarlyFlow — pump.fun launch-flow rider for agent-fun/replay/v2.
//
// Idea (measured on the kit's 24h dev window, 1222 coins, before writing this):
// the money is in the first few slots after a coin is created. Decision points at
// age 0-3 slots reach +25% before -10% in 27% of cases (mean forward max 1.61x),
// while age 10-30 only manages 15% (mean max 1.27x). The creator's own buy is
// the strongest single filter: a creator buy of 0.01-0.5 SOL in the create slot
// lifts the TP-first rate to 26.5% with mean forward max 1.65x, while a creator
// buy above 2 SOL (a whale bundle) or no creator buy at all both fall to ~16%.
// Sustained inflow confirms the move: net flow over the trailing 10 slots of at
// least 1 SOL with at least 4 distinct non-creator buyers, and a run-up from the
// create price of 1.2-3x (moved, not parabolic), together lift the TP-first rate
// to ~24% with mean forward max ~1.5x. Everything after that is execution: buy
// small (the 1%-of-real-reserve cap binds early), add once into confirmed flow,
// exit on take-profit (+15%), a trailing stop once up, a stop-loss, a hard time
// limit, a creator sell, or a flow reversal. No clock, no randomness, no I/O:
// the same batches always produce the same orders. Swept result on the full dev
// window: +0.137 SOL mean (worst fail-key +0.134), 24 trips / 9 wins / 24 coins,
// max drawdown 0.8%; halves +0.004 / +0.129; quarters -0.021 / +0.023 / +0.086 /
// +0.043; reversed window 0 trades (no false edge).
//
// Sizing note: curve fees are 95 + 30 bps per side and every order pays a
// 105,000-lamport tx fee, so a round trip costs ~2.5% + 0.00021 SOL. Buys below
// 0.01 SOL never pay for their own fees and do not count toward the 20-coin
// guardrail, so minBuy is 0.01 SOL and entries wait for the real reserve to
// reach 1 SOL (cap = 1% of it).

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addLamports: number;
  /** An add needs the recent net flow at least this (lamports). */
  addMinFlowLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. Small skin in the game, not a whale bundle. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  stakeLamports: 150_000_000,
  minBuyLamports: 10_000_000,
  maxAdds: 1,
  addStepBps: 500,
  addDelay: 2,
  addLamports: 150_000_000,
  addMinFlowLamports: 500_000_000,
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 10_000_000,
  maxDevBuy: 500_000_000,
  minBuyers: 4,
  maxBuyers: 1000,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 12_000,
  maxRunupBps: 30_000,
  flowWindow: 10,
  minFlowLamports: 1_000_000_000,
  minRecentBuyers: 3,
  skipDevSold: true,
  buySlippageBps: 1500,
  tpBps: 1500,
  slBps: 1000,
  trailArmBps: 2000,
  trailBps: 1500,
  maxHold: 100,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
};

const BPS = 10_000n;
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and adds.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        } else if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && (P.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (isAdd) {
          // A second tranche once the launch has shown it is not an instant dump:
          // still rising from the last buy, and net flow still coming in.
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          if (flow(c, state.slot).net < BigInt(P.addMinFlowLamports)) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const want = BigInt(P.addLamports);
          const room = stake - c.spentSent;
          const amount = want < maxAdd ? (want < room ? want : room) : (maxAdd < room ? maxAdd : room);
          if (amount < minBuy || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // Entry filters: real reserve, creator skin in the game, crowd, flow, run-up.
// Chosen by sweeping the full dev window (see STRATEGY.md): at least 4 distinct
// non-creator buyers, creator buy 0.01-0.5 SOL, trailing-10-slot net flow at
// least 1 SOL, run-up 1.2-3x from creation, first buy within 6 slots of it.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < 1 || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}
