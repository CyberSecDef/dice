// server.js — Express + ws (WebSocket) game server for Yahtzee-line
// Port: 8006 (env PORT respected)
// Game: 15 rounds. Each round has 3 selection phases (10s each) then a scoring phase.
// Players must keep >=1 die each selection phase, max 5 kept total, >=3 kept by end.
// If a player fails to pick in time, one random die from that phase is auto-kept.
// If a player fails to choose a scoring category in time, the least-valuable unused category is zeroed.
// After 15 rounds, show a winner; 30s later, auto-restart a fresh game.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const cookie = require('cookie');

const PORT = process.env.PORT || 8006;
const HOST = "0.0.0.0";

const app = express();
app.set('trust proxy', true);
app.use(express.static('public', { etag: true, lastModified: true, cacheControl: true, maxAge: '1h' }));

// Optional logs folder exists per tree, nothing to do here.
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** -------------------------------
 * Game configuration
 * ------------------------------*/
const PHASE_DURATION_MS = 10000;         // 10s per selection phase
const SCORE_DURATION_MS = 10000;         // 10s for scoring decision
const ROUNDS_PER_GAME = 15;
const EVENT_LOG_MAX = 250;               // keep last N events
const DISCONNECT_STALE_MS = 60_000;      // remove from leaderboard if away >60s
const GAME_RESTART_DELAY_MS = 30_000;    // after winner shown

// Category ordering (used to choose "least valuable" for zero on timeout)
const CATEGORY_ORDER = [
    'Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes',
    'One Pair', 'Two Pair', 'Three of a Kind', 'Four of a Kind',
    'Full House', 'Small Straight', 'Large Straight', 'Yippee', 'Scratch'
];

const CATEGORY_FIXED_SCORES = {
    'Full House': 25,
    'Small Straight': 30,
    'Large Straight': 40,
    'Yippee': 50
};

// Utility
const now = () => Date.now();
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rollFiveDice = () => [0, 0, 0, 0, 0].map(() => randInt(1, 6));
const clampName = s => (s || '').toString().trim().slice(0, 16).replace(/[^\x20-\x7E]/g, '');

function scoreCategory(category, dice) {
    // Only legit faces; do NOT pad with zeros.
    const vals = (dice || []).filter(n => Number.isInteger(n) && n >= 1 && n <= 6);
    console.log("Vals:", vals)
    // Frequency table for 1..6
    const counts = Array(7).fill(0);
    for (const d of vals) counts[d]++;

    const sum = vals.reduce((a, b) => a + b, 0);
    console.log("Sum: ", sum)
    const faceSum = f => counts[f] * f;

    const uniq = Array.from(new Set(vals)).sort((a, b) => a - b);
    const haveN = n => counts.some(c => c >= n);

    // Helpers for straights
    const hasRun = (runArr) => runArr.every(x => uniq.includes(x));
    const smallStraight = (uniq.length >= 4) && (
        hasRun([1, 2, 3, 4]) || hasRun([2, 3, 4, 5]) || hasRun([3, 4, 5, 6])
    );
    const largeStraight = (vals.length === 5) && (
        uniq.length === 5 &&
        (uniq.join(',') === '1,2,3,4,5' || uniq.join(',') === '2,3,4,5,6')
    );

    const fullHouse = (vals.length === 5) && counts.includes(3) && counts.includes(2);
    const threeKind = haveN(3);   // may be true with <5 dice
    const fourKind = haveN(4);   // may be true with <5 dice
    const fiveKind = (vals.length === 5) && counts.includes(5);

    switch (category) {
        // Upper section — valid with any count ≥1
        case 'Ones': return faceSum(1);
        case 'Twos': return faceSum(2);
        case 'Threes': return faceSum(3);
        case 'Fours': return faceSum(4);
        case 'Fives': return faceSum(5);
        case 'Sixes': return faceSum(6);

        // Pairs & kinds — valid with fewer than 5 kept; score = sum of kept dice
        case 'One Pair': {
            for (let f = 6; f >= 1; f--) if (counts[f] >= 2) return f * 2;
            return 0;
        }
        case 'Two Pair': {
            const faces = [];
            for (let f = 6; f >= 1; f--) if (counts[f] >= 2) faces.push(f);
            return faces.length >= 2 ? faces[0] * 2 + faces[1] * 2 : 0;
        }
        case 'Three of a Kind': return threeKind ? sum : 0;
        case 'Four of a Kind': return fourKind ? sum : 0;

        // Straights
        case 'Small Straight': return smallStraight ? 30 : 0;                  // can be exactly 4 kept dice
        case 'Large Straight': return largeStraight ? 40 : 0;                  // must be all 5 in sequence

        // Fixed combos requiring all five dice
        case 'Full House': return fullHouse ? 25 : 0;
        case 'Yippee': return fiveKind ? 50 : 0;

        // Always sum of whatever you kept
        case 'Scratch': return sum;

        default: return 0;
    }
}


function leastValuableUnusedCategory(used) {
    // used: Set of category names already taken by this player
    for (const cat of CATEGORY_ORDER) {
        if (!used.has(cat)) return cat;
    }
    // Shouldn’t happen; fallback:
    return 'Scratch';
}

/** -------------------------------
 * In-memory state
 * ------------------------------*/
let game = {
    round: 1,
    phase: 1,  // 1,2,3 selection phases; 4 = scoring phase; 0 = between games (winner show)
    phaseEndsAt: now() + PHASE_DURATION_MS,
    // Dice pool per phase (for display); players can only pick from current phase
    phaseDice: { 1: rollFiveDice(), 2: [], 3: [] },
    winner: null,
    restartingAt: null
};

// Player model
// players: Map<playerId, player>
const players = new Map();
// sessions: Map<sessionId, playerId>
const sessions = new Map();

function newPlayer(sessionId, name) {
    const id = uuidv4();
    const p = {
        id,
        sessionId,
        name: clampName(name) || 'Player',
        connected: true,
        lastSeen: now(),
        totalScore: 0,
        // per game data:
        usedCategories: new Set(), // names used this game
        roundSelections: {         // per round, what dice kept and from which phases
            // structure: phase1: [], phase2: [], phase3: [], final: [] (computed)
        },
        perRoundScore: {},         // roundNumber => { category, points, dice }
        // connection handle (ws) set on connect:
        ws: null
    };
    players.set(id, p);
    sessions.set(sessionId, id);
    return p;
}

function getOrCreateBySession(sessionId, name) {
    let pid = sessions.get(sessionId);
    if (!pid || !players.has(pid)) {
        return newPlayer(sessionId, name);
    }
    const p = players.get(pid);
    if (name) p.name = clampName(name);
    return p;
}

function markSeen(p) {
    p.connected = true;
    p.lastSeen = now();
}

function broadcast(kind, payload) {
    const msg = JSON.stringify({ type: kind, ...payload });
    for (const p of players.values()) {
        if (p.ws && p.ws.readyState === p.ws.OPEN) {
            p.ws.send(msg);
        }
    }
}

const eventLog = []; // Array of {ts, text}
function logEvent(text) {
    eventLog.push({ ts: now(), text });
    if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
    broadcast('eventLog', { events: eventLog });
}

function leaderboardTop10() {
    // Filter out stale/disconnected beyond DISCONNECT_STALE_MS
    const t = now();
    const live = [...players.values()].filter(p => t - p.lastSeen <= DISCONNECT_STALE_MS);
    live.sort((a, b) => b.totalScore - a.totalScore);
    return live.slice(0, 10).map(p => ({ id: p.id, name: p.name, totalScore: p.totalScore }));
}

function publicState() {
    return {
        serverNow: now(),
        round: game.round,
        phase: game.phase,
        phaseEndsAt: game.phaseEndsAt,
        phaseDice: game.phaseDice,
        winner: game.winner ? { id: game.winner.id, name: game.winner.name, totalScore: game.winner.totalScore } : null,
        restartingAt: game.restartingAt,
        leaderboard: leaderboardTop10(),
        events: eventLog
    };
}

function playerPrivateState(p) {
    // Assemble the player’s current selections for UI
    const sel = p.roundSelections[game.round] || { phase1: [], phase2: [], phase3: [], final: [] };
    // Compute “final” as concatenation up to 5 dice
    const final = [...sel.phase1, ...sel.phase2, ...sel.phase3].slice(0, 5);
    sel.final = final;
    return {
        you: {
            id: p.id,
            name: p.name,
            totalScore: p.totalScore,
            usedCategories: [...p.usedCategories],
            selections: sel,
            perRoundScore: p.perRoundScore
        }
    };
}

function sendState(p) {
    if (!p.ws || p.ws.readyState !== p.ws.OPEN) return;
    p.ws.send(JSON.stringify({ type: 'state', ...publicState(), ...playerPrivateState(p) }));
}

/** -------------------------------
 * Round / Phase engine
 * ------------------------------*/
function resetGameForAll() {
    for (const p of players.values()) {
        p.totalScore = 0;
        p.usedCategories = new Set();
        p.roundSelections = {};
        p.perRoundScore = {};
    }
    game = {
        round: 1,
        phase: 1,
        phaseEndsAt: now() + PHASE_DURATION_MS,
        phaseDice: { 1: rollFiveDice(), 2: [], 3: [] },
        winner: null,
        restartingAt: null
    };
    logEvent(`New game started. Round 1 begins.`);
    broadcast('state', publicState());
    // also send private states
    for (const p of players.values()) sendState(p);
}

function nextPhaseOrRound() {
    if (game.phase === 1) {
        game.phase = 2;
        game.phaseDice[2] = rollFiveDice();
        game.phaseEndsAt = now() + PHASE_DURATION_MS;
        logEvent(`Phase 2: new dice rolled.`);
    } else if (game.phase === 2) {
        game.phase = 3;
        game.phaseDice[3] = rollFiveDice();
        game.phaseEndsAt = now() + PHASE_DURATION_MS;
        logEvent(`Phase 3: final selection phase dice rolled.`);
    } else if (game.phase === 3) {
        // Move to scoring phase (phase 4)
        game.phase = 4;
        game.phaseEndsAt = now() + SCORE_DURATION_MS;
        logEvent(`Scoring phase: choose a category.`);
        for (const p of players.values()) {
            const r = p.roundSelections[game.round] || (p.roundSelections[game.round] = { phase1: [], phase2: [], phase3: [], final: [] });
            // make sure arrays exist
            r.phase1 = Array.isArray(r.phase1) ? r.phase1 : [];
            r.phase2 = Array.isArray(r.phase2) ? r.phase2 : [];
            r.phase3 = Array.isArray(r.phase3) ? r.phase3 : [];
            r.final = [...r.phase1, ...r.phase2, ...r.phase3].slice(0, 5);
        }

    } else if (game.phase === 4) {
        let skipped = 0;
        for (const p of players.values()) {
            if (!p.perRoundScore[game.round]) skipped++;
        }
        logEvent(`Round ${game.round} ended.${skipped ? ` ${skipped} player(s) skipped scoring.` : ''}`);
        // Next round or end game
        if (game.round < ROUNDS_PER_GAME) {
            game.round += 1;
            game.phase = 1;
            game.phaseEndsAt = now() + PHASE_DURATION_MS;
            game.phaseDice = { 1: rollFiveDice(), 2: [], 3: [] };
            logEvent(`Round ${game.round} begins.`);
        } else {
            // Determine winner(s)
            const live = [...players.values()];
            live.sort((a, b) => b.totalScore - a.totalScore);
            const top = live[0] || null;
            game.winner = top ? { id: top.id, name: top.name, totalScore: top.totalScore } : null;
            logEvent(top ? `Winner: ${top.name} with ${top.totalScore} points.` : `Game ended with no players.`);
            // Freeze phases and schedule restart
            game.phase = 0;
            game.phaseEndsAt = null;
            game.restartingAt = now() + GAME_RESTART_DELAY_MS;
            setTimeout(() => resetGameForAll(), GAME_RESTART_DELAY_MS);
        }
    }
    broadcast('state', publicState());
    for (const p of players.values()) sendState(p);
}

// Phase ticker
setInterval(() => {
    const t = now();
    // Periodic cleanup: mark long-gone players as disconnected (affects leaderboard)
    for (const p of players.values()) {
        if (p.ws && p.ws.readyState !== p.ws.OPEN) p.connected = false;
    }
    if (game.phase !== 0 && t >= game.phaseEndsAt) {
        nextPhaseOrRound();
    } else {
        // still broadcast periodic state for timers and leaderboards
        broadcast('tick', publicState());
    }
}, 200);

/** -------------------------------
 * WebSocket handling
 * ------------------------------*/
wss.on('connection', (ws, req) => {
    // Parse cookies for session fallback
    let cookies = {};
    try {
        cookies = cookie.parse(req.headers.cookie || '');
    } catch { }
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let msg = {};
        try { msg = JSON.parse(data.toString()); } catch { return; }

        // Expect initial hello with sessionId and name
        if (msg.type === 'hello') {
            const sessionId = (msg.sessionId && typeof msg.sessionId === 'string') ? msg.sessionId : (cookies.sessionId || uuidv4());
            const name = clampName(msg.name);
            const player = getOrCreateBySession(sessionId, name);
            player.ws = ws;
            markSeen(player);
            // Update name if provided and changed
            if (name && name !== player.name) player.name = name;

            // Welcome events
            logEvent(`${player.name} joined the game.`);
            // Send immediate state snapshot to this player
            ws.send(JSON.stringify({ type: 'welcome', sessionId: sessionId, youId: player.id }));
            sendState(player);
            return;
        }

        // Identify player by attached session/player mapping
        let player = null;
        for (const p of players.values()) if (p.ws === ws) { player = p; break; }
        if (!player) return;

        markSeen(player);

        if (msg.type === 'setName') {
            let requested = (msg.name || '').trim().slice(0, 16);
            if (!requested) return;

            // Check existing names (case-insensitive)
            const lower = requested.toLowerCase();
            const taken = Array.from(players.values()).filter(p => p.name && p.name.toLowerCase() === lower);

            if (taken.length > 0) {
                // Find the next available numeric suffix
                let n = 2;
                let candidate = `${requested} ${n}`;
                const existing = new Set(Array.from(players.values()).map(p => p.name.toLowerCase()));
                while (existing.has(candidate.toLowerCase())) {
                    n++;
                    candidate = `${requested} ${n}`;
                }
                requested = candidate;
            }

            player.name = requested;
            logEvent(`${requested} joined the game.`);

            sendState(player);
            broadcast(publicState());
            return;
        }


        if (msg.type === 'selectDice') {
            const { phase, indices } = msg;
            if (![1, 2, 3].includes(phase)) return;
            if (game.phase !== phase) return; // only from current phase
            const diceArr = game.phaseDice[phase];
            if (!Array.isArray(indices)) return;

            const r = player.roundSelections[game.round] || (player.roundSelections[game.round] = { phase1: [], phase2: [], phase3: [], final: [] });

            // Translate indices to dice values for that phase
            const chosen = indices
                .filter(i => Number.isInteger(i) && i >= 0 && i < diceArr.length)
                .map(i => diceArr[i]);

            // IMPORTANT: compute space excluding this phase’s previous picks
            const prevThisPhase = (r[`phase${phase}`] || []).length;
            const keptOther = ([1, 2, 3]
                .filter(ph => ph !== phase)
                .reduce((n, ph) => n + (r[`phase${ph}`] ?.length || 0), 0));
            const spaceLeft = Math.max(0, 5 - keptOther);
            // Now cap the new selection for this phase to the space that’s truly left
            const take = chosen.slice(0, spaceLeft);

            r[`phase${phase}`] = take;

            // Update final
            r.final = [...r.phase1, ...r.phase2, ...r.phase3].slice(0, 5);
            console.log(`[selectDice] ${player.name} r.phase1=${JSON.stringify(r.phase1)} r.phase2=${JSON.stringify(r.phase2)} r.phase3=${JSON.stringify(r.phase3)} final=${JSON.stringify(r.final)}`);

            sendState(player);
            return;
        }

        if (msg.type === 'scoreCategory') {
            if (game.phase !== 4) return;

            const category = (msg.category || '').toString();
            if (!CATEGORY_ORDER.includes(category)) return;
            if (player.usedCategories.has(category)) return; // already used

            // Determine player's final dice for this round
            const r = player.roundSelections[game.round] || { phase1: [], phase2: [], phase3: [], final: [] };
            const kept = [...(r.final || [])];

            console.log(r);
            console.log(kept);
            const pts = scoreCategory(category, kept);

            player.usedCategories.add(category);
            player.perRoundScore[game.round] = { category, points: pts, dice: kept };
            player.totalScore += pts;

            logEvent(`${player.name} scored ${pts} on ${category}.`);
            // Push updated state
            broadcast('state', publicState());
            for (const p of players.values()) sendState(p);
            return;
        }
    });

    ws.on('close', () => {
        // mark player disconnected for leaderboard pruning; remove later if stale
        let player = null;
        for (const p of players.values()) if (p.ws === ws) { player = p; break; }
        if (player) {
            player.connected = false;
            player.ws = null;
            player.lastSeen = now();
            logEvent(`${player.name} disconnected.`);
            broadcast('state', publicState());
        }
    });
});

// Heartbeat to terminate dead sockets
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

server.on('upgrade', (req, socket) => {
    console.log('Upgrade headers:', req.headers);
});

server.listen(PORT, () => {
    console.log(`Dice Trackr server listening on http://${HOST}:${PORT}`);
    resetGameForAll();
});
