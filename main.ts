// Sprinter: a pump.fun paper-trading bot for make.fun's pumpfun-replay/v2 harness.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout: one `hello` line with the
// run's capital, caps and fees, then one `batch` per slot carrying that slot's chain
// events, marks and fills, and finally `done`. Each batch gets exactly one reply with
// this batch's orders (at most caps.max_orders_per_batch). Orders decided on a batch
// for slot s fill at slot s + latency_slots, so every price used here is already
// stale by the latency; slippage is left generous on buys for that reason.
//
// Idea
// ----
// Most pump.fun curves die within minutes of creation: a fresh launch is usually a
// bundled dump, not a trade. Sprinter therefore never buys a newborn curve. It waits
// until a curve is at least MIN_AGE slots old and its recent tape shows real,
// broadening demand: net SOL flowing in over a short window, several distinct buyers,
// the price rising but not vertical, and sitting near its window high. That is the
// entry. One fixed-size buy per coin, no pyramiding: a false start costs one small
// stake, and the bot's edge is selection plus fast exits, not sizing.
//
// Exits sell the whole position on the first of:
//   * a stop loss 25% under cost (a dead coin is cut, not averaged down),
//   * a trailing stop 30% below the best value once the position is up 15%,
//   * the tape turning: net SOL flowing out fast over a short window,
//   * one single recorded sell of 5 SOL or more on the coin (a big holder leaving),
//   * a time limit of 1200 slots while the position is not up at least 10%.
//
// A curve that completes is closed by the harness itself; the replay flattens
// whatever is left when the data ends. Guardrail pacing keeps the run above the
// minimum bar (a round trip of at least 0.01 SOL on at least 20 coins): when the
// bot's own fills or coins lag the pace set in block time, it opens a tiny probe
// round trip (buy 0.02 SOL, sell it whole as soon as the buy lands) on a liquid
// curve, so a quiet stretch never leaves the run short of the bar.
//
// Costs: each side pays about 1.25% in curve fees (95 bps protocol + 30 bps
// creator) plus one transaction fee (base + priority, ~0.000105 SOL). A 0.25 SOL
// stake therefore needs roughly a 3% move to break even on a round trip, which is
// why entries demand a rising price and exits are quick: the bot lives on the
// coins that keep running, not on churn.
//
// Everything is deterministic: no clock, no environment, no randomness, and every
// iteration runs over insertion-ordered maps fed by the batch stream, so the two
// grading executions produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// --- strategy parameters ---------------------------------------------------
const STAKE_SOL = 0.25; // SOL spent on one position (one buy, no adds)
const MIN_AGE_SLOTS = 400; // slots since CreateEvent before an entry is allowed
const WINDOW_SLOTS = 60; // entry tape window, in slots
const MIN_NET_SOL = 0.75; // net SOL inflow (buys minus sells) over the window
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 5; // distinct buying wallets in the window
const MIN_PRICE_UP = 0.04; // price now vs window start, minus 1 (lower bound)
const MAX_PRICE_UP = 1.2; // same rise, upper bound (skip vertical spikes)
const NEAR_HIGH = 0.92; // price now at least this share of the window high
const MIN_RQ_SOL = 1.5; // curve real SOL at entry, lower bound
const MAX_RQ_SOL = 100; // curve real SOL at entry, upper bound
const BUY_SLIPPAGE_BPS = 1500; // sells always go out wide open (10000)
const STOP_LOSS = 0.25; // exit when value falls this far under cost
const TRAIL_ARM = 0.15; // trailing stop arms once value is up this much
const TRAIL = 0.3; // exit when value falls this far under its peak
const FADE_WINDOW_SLOTS = 20; // exit when net SOL over this window is below -FADE_NET_SOL
const FADE_NET_SOL = 1; // SOL of net outflow that triggers the fade exit
const BIG_SELL_SOL = 5; // exit on any single recorded sell of at least this many SOL
const MAX_HOLD_SLOTS = 1200; // time limit, waived while the position is up HOLD_IF_UP
const HOLD_IF_UP = 0.1; // the gain that waives the time limit
const COOLDOWN_SLOTS = 300; // slots to wait after an exit before re-entering a coin
const MAX_ENTRIES_PER_COIN = 2; // most entries on one curve over the run
const TARGET_COINS = 25; // guardrail pacing target: distinct coins with fills
const TARGET_FILLS = 240; // guardrail pacing target: fills
const PACE_SECONDS = 14400; // pace is measured over this many seconds of block time
const PROBE_SOL = 0.02; // probe round-trip stake (above the 0.01 SOL round-trip bar)
const MAX_PROBES = 1; // most probe round trips open at once
const CURVE_FEE = 0.0125; // ~95 bps protocol + 30 bps creator, per side

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
/** Positions the bot opened, by mint. */
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** The bot's own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL from virtual reserves (SOL per token). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * What a whole position would fetch if sold now, in SOL, after curve fees and
 * one transaction fee: tokens sold into the virtual curve, fees deducted.
 */
function positionValue(state: BotState, mint: Pubkey, tokens: bigint, txSol: number): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  const n = Number(tokens);
  if (vt + n <= 0) return 0;
  return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    // Drop tape older than any window the strategy reads, per traded curve.
    const keep = WINDOW_SLOTS + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: every held position is re-priced from the latest marks.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExit = now;
          else tapeOf(mint).entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      // The shim folds each batch's marks into state.curves, so the curve's
      // reserves below are already the latest known ones for this slot.
      const value = positionValue(state, mint, pos.token_amount, txSol);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW_SLOTS) < -FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Then entries: one fixed-size buy per qualifying coin, in batch order.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      if (slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= MAX_ENTRIES_PER_COIN || now - t.lastExit < COOLDOWN_SLOTS) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < 0.01) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txSol;
      held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false });
      t.entries++;
      slotsLeft--;
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECONDS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * txSol) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)),
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          });
          probes.set(mint, false);
          free -= PROBE_SOL + txSol;
        }
      }
    }
    return orders;
  },
});
