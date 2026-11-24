# EarlyFlow — strategy notes

Measured on the kit's frozen 24h dev window (1,222 coins, 128,058 events)
before choosing anything. Official kit baselines on the same full window:

| bot | net PnL (mean over 4 fail keys) | trips | wins | max DD |
| --- | --- | --- | --- | --- |
| momentum pilot | −9.60 SOL | ~82 | 5–7 | 0.95 |
| reversion pilot | −3.91 SOL | ~425 | 115 | 0.49 |
| sniper pilot | −0.49 SOL | ~349 | 45 | 0.05 |
| **EarlyFlow (this entry)** | **+0.137 SOL** | 24 | 9 | 0.008 |

Final defaults (swept, not the first guess): first buy within 6 slots,
≥4 distinct non-creator buyers, creator buy 0.01–0.5 SOL, trailing-10-slot
net flow ≥ 1 SOL, run-up 1.2–3x, take-profit +15%, stop-loss −10%. Full
window: +0.137 SOL mean (worst fail-key +0.134), 24 trips / 9 wins / 24
coins, 56–57 fills, 1 max-slippage reject, max drawdown 0.8%. Still
positive without the best trip (+0.064) and without the top two (+0.024).
Halves: +0.004 / +0.129. Quarters: −0.021 / +0.023 / +0.086 / +0.043
(worst quarter −0.021 on 4 trades). Reversed window: 0 trades, 0.000 SOL
(no false edge — the profit comes from the real launch direction, not a
statistical artifact). At 2x fees the same settings lose −0.030 SOL, so the
edge lives in the fee structure as published, not in a fee holiday.

## What the window looks like

- Prices peak fast: median time-to-peak 5 slots after creation; 20% of coins
  reach 2x peak, 12% reach 3x, 7% reach 5x — but the pump is mostly over
  within the first ~10 slots, and holding longer only bleeds (at the 1 SOL
  real-reserve cross, +10 slots averages 1.52x, +500 slots 1.40x, +2000 slots
  1.31x, with 60% below 0.9x by then).
- Fees dominate small trades: 95 + 30 bps curve fees per side plus a 105,000
  lamport tx fee per order, so a round trip costs ~2.5% + 0.00021 SOL. Buys
  below 0.01 SOL never pay for themselves and do not count toward the
  20-coin guardrail.
- The size cap binds everything: a buy may spend at most 1% of the coin's
  real SOL reserve, and real reserves start at 0. At the 1 SOL cross the most
  one reply can buy is 0.01 SOL.

## Entry edge (decision-point analysis, TP +25% / SL −10% race, next 100 slots)

- Age 0–3 slots: 27.3% reach +25% before −10% (mean forward max 1.61x).
  Age 3–10: 18.0%. Age 10–30: 15.1%. Enter early or not at all.
- Creator's own buy in the create slot of 0.01–0.5 SOL: 26.5% TP-first,
  mean forward max 1.65x. No creator buy: 17.0%. Creator buy above 2 SOL
  (whale bundle): 16.1%.
- Combined filter (run-up 1.2–2x, trailing-10-slot net flow ≥ 1 SOL,
  creator buy < 0.5 SOL, creator not sold): 24.1% TP-first, mean forward
  max 1.49x, mean price +25% after 20 slots.
- Trailing flow and buyer counts help only weakly on their own; the
  combination above is what selects the runners.

## Execution

- First buy at most `stake` (0.15 SOL), capped at 1% of real reserves, only
  once per coin, only in its first 3 slots, only when every filter passes.
- One add into confirmed flow (price ≥ +5% from the last buy, net flow
  still ≥ 0.5 SOL) up to the same stake.
- Exits, first trigger wins: take-profit +25%, stop-loss −10%, trailing stop
  −15% once +20% up, hard time limit 100 slots, creator sells while held,
  flow reversal. Sells go out at 10,000 bps slippage so a position never
  gets stuck; buys at 1,500 bps so a fill 2 slots later at a much worse
  price is refused instead of chased.
- At most 5 open positions (the harness cap); cash is checked against
  pending orders before every buy, so the bot never promises SOL it does
  not have.

## Robustness

- Deterministic: no clock, no randomness, no I/O; iteration only over
  insertion-ordered maps fed by the batch stream, so the two graded
  executions produce byte-identical action logs.
- Tested on the full dev window across 4 failed-tx seeds, on each half and
  each quarter, and on the reversed window (see RUN-STATE.md). The dev gate
  is a positive net PnL with margin, not a bare pass.
