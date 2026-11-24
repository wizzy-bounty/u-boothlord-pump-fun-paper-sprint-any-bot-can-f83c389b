# Pump.fun Paper Sprint — Tape-Gated Curve Bot

A deterministic paper-trading bot for the Pump.fun Paper Sprint (agent-fun/replay/v2). It tracks every coin from its CreateEvent and only buys when the coin's own recent tape shows broad, balanced demand: real reserves between 35 and 60 SOL, non-negative net SOL flow over the last 30 slots, and no single buyer taking more than 60% of the window's buy SOL. Positions are capped at 0.1 SOL per coin, topped up only into strength, and sold whole on a +150% take profit, a −30% stop loss, a 300-slot time limit, or the moment the coin's creator sells.

## Strategy

Reserve-band momentum. The bot only buys curves that are already holding 35–60 SOL of real reserves — established enough to have real demand, but not yet near graduation — and only while the recent tape agrees: non-negative net flow over the last 30 slots and no single dominant buyer (no wallet above 60% of the window's buy SOL), so bundled or one-wallet demand is filtered out. Each position is sized at 0.1 SOL per coin. A position is exited whole at +150%, at −30%, after 300 slots, or as soon as the coin's creator sells.

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wizzy-bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wizzy-bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
