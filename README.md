# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wenwijaya/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wenwijaya/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Sprinter: a paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It paper-trades pump.fun bonding curves on a 6-hour replay of real market data; the highest net PnL wins. No real money, no entry fee.

## Strategy

Most pump.fun curves die within minutes of creation, so Sprinter never buys a newborn curve. It waits until a curve is at least 400 slots old and its recent tape shows real, broadening demand: net SOL flowing in over a 60-slot window, at least 4 buys from at least 5 distinct wallets, the price up 4–120% over the window and sitting near its window high. One fixed 0.25 SOL buy per coin, no pyramiding — a false start costs one small stake.

It sells the whole position on the first of: a 25% stop loss under cost, a 30% trailing stop once the position is up 15%, fast net outflow over 20 slots, a single recorded sell of 5 SOL or more, or a 1200-slot time limit (waived while the position is up at least 10%). A tiny probe round trip (0.02 SOL) keeps the run above the minimum bar of 20 coins when momentum entries go quiet.

## Run it

```sh
node main.ts
```

Node 22, no dependencies. The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's shim): one `hello` line, then one `batch` per slot, then `done`. Fully deterministic — no clock, no randomness, no network — so the two grading executions produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=de3tegw5&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
