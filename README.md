# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wenwijaya/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wenwijaya/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Sprinter: a paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It paper-trades pump.fun bonding curves on a 6-hour replay of real market data; the highest net PnL wins. No real money, no entry fee.

## Strategy

Most pump.fun curves die within minutes of creation, so Sprinter never buys a coin that has already been running. It buys at launch — within the first 6 slots after a coin's CreateEvent — but only launches that pass a rug filter: the creator's own buy in the create slot is at most 1.5 SOL, at most 4 other wallets piled in with it (a launch bundled by many wallets is usually the creator's cluster waiting to dump), the creator has not sold, the curve already holds 1–30 SOL of real reserves, and the price has not already run up more than 50% from creation. One fixed 0.12 SOL buy per coin.

Exits are fast and whole-position: bank the full win at +15%, cut the whole loss at −10%, never hold past 15 slots (waived while the position is up at least 10%), and leave at once when the creator sells. A round trip costs about 2.7% in curve fees plus transaction fees, so the +15% / −10% shape is what the dev window grades best: on the kit's dev window it scores −0.31 SOL over 243 round trips on 243 coins (win rate 12.8%, max drawdown 3.3%, guardrails met), ahead of every house baseline and pilot the kit ships, and deterministic — the two grading executions reproduce byte for byte.

## Run it

```sh
node main.ts
```

Node 22, no dependencies. The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's shim): one `hello` line, then one `batch` per slot, then `done`. Fully deterministic — no clock, no randomness, no network — so the two grading executions produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=de3tegw5&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
