// Tape-gated bonding-curve strategy for the Pump.fun Paper Sprint.
//
// The idea is deliberately narrow. Most fresh pump.fun curves are bundled launches or
// one-wallet shows, so this bot refuses almost everything and only touches a coin once
// its own recorded tape shows broad, balanced demand in a reserve band where a curve is
// established but still has room to run:
//
//   - Every coin is tracked from its CreateEvent: create slot, create price, creator, a
//     rolling tape of its trades (capped at the last 400), and a flag set the moment the
//     creator sells. A creator sell is treated as the strongest possible negative signal:
//     it blocks new entries and exits any open position on that coin immediately.
//   - Entries look at the last 30 slots of tape. A first buy needs real reserves between
//     35 and 60 SOL, at least one buy from at least one distinct buyer, non-negative net
//     SOL flow (buys minus sells), and no single buyer accounting for more than 60% of
//     the buy SOL in the window. One wallet dominating the tape means the demand is not
//     real, however green the curve looks.
//   - Position size is capped at 0.1 SOL per coin in total. A position is topped up
//     toward that cap only while the same tape and reserve gates still hold and the
//     current price is at or above the price of the previous buy decision, so the bot
//     adds into strength and never averages down.
//   - A coin gets at most two lifetime entries, and after an exit the bot waits at
//     least 300 slots before the same coin can be entered again.
//   - Exits are checked before entries on every batch and sell the whole position on
//     the first of: value at or above 2.5x cost (take profit), value at or below 0.7x
//     cost (stop loss), 300 slots held since the entry decision, or a creator sell.
//
// Value is marked from the curve itself: price is virtual_quote_reserves over
// virtual_token_reserves from the latest known reserves, and the exit value deducts a
// 1.25% curve fee plus the transaction fee before comparing against cost.
//
// The strategy is a pure function of the batch stream: no clock, no randomness, no I/O,
// and every map is iterated in insertion order, so the two grading executions agree
// byte for byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// All of the strategy's numeric settings in one place. Every value here is exactly
// the value the logic below has always used; the code reads from this object so the
// tuning can be audited at a glance.
export const PARAMS = {
  minReserveSol: 35,
  maxReserveSol: 60,
  tapeWindowSlots: 30,
  maxTopBuyerShare: 0.6,
  targetPerCoinLamports: 100_000_000n,
  minBuyLamports: 5_000_000n,
  buySlippageBps: 1500,
  takeProfitMultiple: 2.5,
  stopLossMultiple: 0.7,
  exitValueFactor: 0.9875,
  maxHoldSlots: 300,
  reentryCooldownSlots: 300,
  maxEntriesPerCoin: 2,
  tapeKeep: 400,
  sellSlippageBps: 10000,
} as const;

interface TapeTrade {
  slot: number;
  buy: boolean;
  solLamports: bigint;
  user: Pubkey;
}

interface CoinRecord {
  createdSlot: number;
  createPrice: number;
  creator: Pubkey;
  tape: TapeTrade[];
  creatorSold: boolean;
  entries: number;
  lastExitSlot: number | null;
  lastBuyPrice: number | null;
  entrySlot: number | null;
  hadPosition: boolean;
}

interface TapeStats {
  buys: number;
  distinctBuyers: number;
  netLamports: bigint;
  topBuyerShare: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(): Strategy {
  const coins = new Map<Pubkey, CoinRecord>();

  const pendingFor = (state: BotState, mint: Pubkey): { buyQuote: bigint; anyBuy: boolean; anySell: boolean } => {
    let buyQuote = 0n;
    let anyBuy = false;
    let anySell = false;
    for (const p of state.pending.values()) {
      if (p.order.mint !== mint) continue;
      if (p.order.side === 'buy') {
        anyBuy = true;
        buyQuote += BigInt(p.order.quote_lamports);
      } else {
        anySell = true;
      }
    }
    return { buyQuote, anyBuy, anySell };
  };

  const tapeStats = (rec: CoinRecord, now: number): TapeStats => {
    const from = now - PARAMS.tapeWindowSlots;
    let buys = 0;
    let net = 0n;
    let totalBuy = 0n;
    const byBuyer = new Map<Pubkey, bigint>();
    for (const tr of rec.tape) {
      if (tr.slot <= from) continue;
      if (tr.buy) {
        buys++;
        net += tr.solLamports;
        totalBuy += tr.solLamports;
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0n) + tr.solLamports);
      } else {
        net -= tr.solLamports;
      }
    }
    let top = 0n;
    for (const v of byBuyer.values()) if (v > top) top = v;
    const share = totalBuy > 0n ? Number(top) / Number(totalBuy) : 0;
    return { buys, distinctBuyers: byBuyer.size, netLamports: net, topBuyerShare: share };
  };

  const gatesPass = (rec: CoinRecord, now: number, reserveSol: number): boolean => {
    if (reserveSol < PARAMS.minReserveSol || reserveSol > PARAMS.maxReserveSol) return false;
    if (rec.creatorSold) return false;
    const s = tapeStats(rec, now);
    if (s.buys < 1) return false;
    if (s.distinctBuyers < 1) return false;
    if (s.netLamports < 0n) return false;
    if (s.topBuyerShare > PARAMS.maxTopBuyerShare) return false;
    return true;
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const now = batch.slot;
    const cap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();

    // Fold this batch's events into the per-coin records, in chain order.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          const vq = Number(e.virtual_quote_reserves);
          const vt = Number(e.virtual_token_reserves);
          coins.set(e.mint, {
            createdSlot: e.slot,
            createPrice: vt > 0 ? vq / vt : 0,
            creator: e.creator,
            tape: [],
            creatorSold: false,
            entries: 0,
            lastExitSlot: null,
            lastBuyPrice: null,
            entrySlot: null,
            hadPosition: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const rec = coins.get(e.mint);
        if (rec === undefined) continue;
        rec.tape.push({ slot: e.slot, buy: e.is_buy, solLamports: BigInt(e.sol_amount), user: e.user });
        if (rec.tape.length > PARAMS.tapeKeep) rec.tape.splice(0, rec.tape.length - PARAMS.tapeKeep);
        if (!e.is_buy && e.user === rec.creator) rec.creatorSold = true;
      }
    }

    // Close out records whose position has fully resolved: the position is gone and no
    // order for the mint is still in flight. A position we actually held stamps the
    // last-exit slot that the re-entry cooldown is measured from.
    for (const [mint, rec] of coins) {
      const pend = pendingFor(state, mint);
      if (state.positions.has(mint)) {
        rec.hadPosition = true;
        if (rec.entrySlot === null) rec.entrySlot = now;
      } else if (rec.entrySlot !== null && !pend.anyBuy && !pend.anySell) {
        if (rec.hadPosition) rec.lastExitSlot = now;
        rec.entrySlot = null;
        rec.hadPosition = false;
      }
    }

    const orders: OrderInput[] = [];
    let budget = state.freeCashLamports();

    // Exits first: every open position, whole, on the first trigger that fires.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      const rec = coins.get(mint);
      if (rec === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingFor(state, mint).anySell) continue;
      if (budget < txFee) continue;
      const vt = Number(curve.virtual_token_reserves);
      if (vt <= 0) continue;
      const price = Number(curve.virtual_quote_reserves) / vt;
      const netValue = Number(pos.token_amount) * price * PARAMS.exitValueFactor - Number(txFee);
      const cost = Number(pos.cost_lamports);
      const heldSlots = rec.entrySlot === null ? 0 : now - rec.entrySlot;
      const takeProfit = netValue >= cost * PARAMS.takeProfitMultiple;
      const stopLoss = netValue <= cost * PARAMS.stopLossMultiple;
      const timedOut = heldSlots >= PARAMS.maxHoldSlots;
      if (!takeProfit && !stopLoss && !timedOut && !rec.creatorSold) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: PARAMS.sellSlippageBps });
      budget -= txFee;
    }

    // Entries and adds, in the order the coins were created.
    let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const [mint, rec] of coins) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const vt = Number(curve.virtual_token_reserves);
      if (vt <= 0) continue;
      const price = Number(curve.virtual_quote_reserves) / vt;
      const reserveSol = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
      const pos = state.positions.get(mint);
      const pend = pendingFor(state, mint);
      const invested = (pos === undefined ? 0n : pos.cost_lamports) + pend.buyQuote;
      const hasExposure = pos !== undefined || pend.anyBuy;
      if (invested >= PARAMS.targetPerCoinLamports) continue;
      if (!gatesPass(rec, now, reserveSol)) continue;
      if (hasExposure) {
        // Add: only into strength, never below the previous buy decision's price.
        if (rec.lastBuyPrice === null || price < rec.lastBuyPrice) continue;
      } else {
        // First buy: lifetime entry cap, post-exit cooldown, and a free position slot.
        if (rec.entries >= PARAMS.maxEntriesPerCoin) continue;
        if (rec.lastExitSlot !== null && now - rec.lastExitSlot < PARAMS.reentryCooldownSlots) continue;
        if (freeSlots <= 0) continue;
      }
      let size = PARAMS.targetPerCoinLamports - invested;
      const maxBuy = state.maxBuyLamports(mint);
      if (maxBuy < size) size = maxBuy;
      if (size < PARAMS.minBuyLamports) continue;
      if (budget < size + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: PARAMS.buySlippageBps });
      budget -= size + txFee;
      rec.lastBuyPrice = price;
      if (!hasExposure) {
        rec.entries++;
        rec.entrySlot = now;
        freeSlots--;
      }
    }

    return orders;
  };

  return { onBatch };
}
