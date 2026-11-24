// Sprinter: a pump.fun launch-snipe bot for make.fun's pumpfun-replay/v2 harness.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout: one `hello` line with
// the run's capital, caps and fees, then one `batch` per slot carrying that slot's
// chain events, marks and fills, and finally `done`. Each batch gets exactly one
// reply with this batch's orders (at most caps.max_orders_per_batch). Orders decided
// on a batch for slot s fill at slot s + latency_slots, so every price used here is
// already stale by the latency; buys go out with wide slippage for that reason.
//
// Idea
// ----
// On pump.fun the money is made in the first seconds of a curve's life: a coin
// either pops on launch hype or bleeds to zero, and by the time a momentum signal
// confirms the move the top is already in (the house momentum pilot loses 95% of
// its capital on the dev window doing exactly that). Sprinter therefore buys at
// launch — within the first few slots after a coin's CreateEvent — but only
// launches that pass a rug filter: the creator's own buy in the create slot is
// small, only a handful of other wallets piled in with it (a launch bundled by
// many wallets is usually the creator's cluster waiting to dump), the creator has
// not sold, and the curve already holds real SOL. One fixed-size buy per coin.
//
// A round trip costs about 2.7% (1.25% curve fees per side plus two transaction
// fees on a 0.12 SOL stake), so a win must clear that bar before it counts. The
// exits are therefore fast and whole-position: bank the full win at +15%,
// cut the whole loss at -10%, never hold past 15 slots, and leave at once when
// the creator sells. Coins that pop and keep running are the exception, not the
// rule — on the dev window, holding half back for a runner gave the gains back
// more often than it caught one, so this version banks everything at the first
// take-profit instead. A curve that completes is closed by the harness itself;
// the replay flattens whatever is left when the data ends.
//
// Everything is deterministic: no clock, no environment, no randomness, and every
// iteration runs over insertion-ordered maps fed by the batch stream, so the two
// grading executions produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// --- strategy parameters ---------------------------------------------------
const STAKE_LAMPORTS = 120_000_000n; // 0.12 SOL per coin (one buy, no adds)
const MIN_BUY_LAMPORTS = 10_000_000n; // smallest buy worth sending (the round-trip bar)
const MIN_AGE_SLOTS = 0; // youngest age (slots since create) at which a coin may be bought
const MAX_AGE_SLOTS = 6; // oldest age at which a first buy may still be decided
const MIN_REAL_SOL_LAMPORTS = 1_000_000_000n; // curve real SOL at decision, lower bound
const MAX_REAL_SOL_LAMPORTS = 30_000_000_000n; // curve real SOL at decision, upper bound
const MAX_DEV_BUY_LAMPORTS = 1_500_000_000n; // creator's own buy in the create slot, at most
const MAX_BUYERS = 4; // distinct non-creator buyers before entry, at most
const MAX_RUNUP_BPS = 5000; // price now over the create price, at most (+50%)
const BUY_SLIPPAGE_BPS = 10_000; // buys go out wide open (latency moves the price)
const TP_BPS = 1500; // exit the whole position once up this much (+15%)
const SL_BPS = 1000; // exit whole when down this much under cost (-10%)
const MAX_HOLD_SLOTS = 15; // time limit while the position is still open
const HOLD_IF_UP_BPS = 1000; // the gain that waives the time limit (+10%)
const BPS = 10_000n;
const FEE_BPS = 125n; // ~95 bps protocol + 30 bps creator, per side

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Transaction fees paid on this position's fills so far. */
  txPaid: bigint;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Mints with a sell in flight. */
const selling = new Set<Pubkey>();

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
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
          devSold: false,
          lastTradeSlot: e.slot,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }

    // Fold the fills in: track the bot's own fills, drop positions the harness closed.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
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
        h = { openedSlot: now, txPaid: tx };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = BigInt(pos.cost_lamports) + h.txPaid;
      let exit = false;
      if (basis > 0n) {
        // Whole-position take-profit: bank the full win as soon as it is there.
        if (value * BPS >= basis * (BPS + BigInt(TP_BPS))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(SL_BPS))) exit = true;
      }
      if (now - h.openedSlot >= MAX_HOLD_SLOTS) {
        if (basis > 0n && value * BPS >= basis * (BPS + BigInt(HOLD_IF_UP_BPS))) {
          // Up enough that the time limit is waived: let it run.
        } else {
          exit = true;
        }
      }
      if (c !== undefined && c.devSold) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // Entries: one fixed-size buy per launch that passes the rug filter, decided
    // while the coin is at most MAX_AGE_SLOTS old.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      const age = now - c.createSlot;
      if (age > MAX_AGE_SLOTS) {
        c.done = true;
        continue;
      }
      if (age < MIN_AGE_SLOTS) continue;
      if (open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        c.done = true;
        continue;
      }
      // Rug filter.
      const rq = curve.real_quote_reserves;
      if (rq < MIN_REAL_SOL_LAMPORTS || rq > MAX_REAL_SOL_LAMPORTS) continue;
      if (c.devBuy > MAX_DEV_BUY_LAMPORTS) continue;
      if (c.buyers.size > MAX_BUYERS) continue;
      if (c.bought <= 0n) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (c.vt0 <= 0n || c.vq0 <= 0n || vt <= 0n) continue;
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup > BPS + BigInt(MAX_RUNUP_BPS)) continue;
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = STAKE_LAMPORTS < maxBuy ? STAKE_LAMPORTS : maxBuy;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx * 6n) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      c.done = true;
      open += 1;
    }
    return orders;
  },
});
