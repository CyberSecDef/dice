# Yahtzee-Line (Express + WebSockets)

Massively-multiplayer Yahtzee-line variant with timed phases, reconnection persistence, leaderboard, and event log.

## Features

- **Unlimited players** via WebSockets (`ws`) on **port 8006**
- **Responsive UI** for phones to desktops
- **Local persistence** with `localStorage` (+ cookie mirror) to restore session, name, and selections after refresh
- **Auto-recovery**: if disconnected >10s, the page auto-reloads
- **Phased rounds**: Three 15-second selection phases (must keep ≥1 die per phase, max 5 total, ≥3 by end), followed by a 15-second scoring phase
- **Auto-assist**: If a player fails to keep at least one die in a phase, one die is auto-kept; if they fail to pick a category, the **least-valuable unused category** is set to **0**
- **Scoring categories**: Ones..Sixes, One Pair, Two Pair, Three/Four of a Kind, Full House (25), Small Straight (30), Large Straight (40), **Yippee** (50), Scratch (sum)
- **15 rounds** per game; winner modal with confetti; **auto-restart after 30s**
- **Global leaderboard** (Top 10), prunes players idle >60s
- **Event log** for joins/leaves/wins/round changes and scoring events

## Run

```bash
npm install
npm start
# open http://localhost:8006
