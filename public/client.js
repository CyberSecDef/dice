/* client.js — Dice Trackr front-end (stable build)
 * - WebSocket client for multiplayer Dice Trackr
 * - Persists sessionId, name, and local index selections in localStorage (+ cookie mirror)
 * - Auto-reloads if disconnected >10s
 * - Index-based per-phase selections (no duplicate-value toggling)
 * - No full UI rebuild on 'tick' (prevents clicks from being clobbered)
 * - Clear local selections only on real round advance (not first sync)
 * - Visual scoring banner + pulsing categories during scoring phase
 */

(function () {
    const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    
    const LS_KEY = 'dice_trackr_state_v1';
    const COOKIE_SESSION = 'sessionId';

    const CATEGORY_ORDER = [
        'Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes',
        'One Pair', 'Two Pair', 'Three of a Kind', 'Four of a Kind',
        'Full House', 'Small Straight', 'Large Straight', 'Yippee', 'Scratch'
    ];

    const els = {
        connStatus: document.getElementById('connStatus'),
        timer: document.getElementById('timer'),
        phaseLabel: document.getElementById('phaseLabel'),
        roundLabel: document.getElementById('roundLabel'),

        nameForm: document.getElementById('nameForm'),
        nameInput: document.getElementById('nameInput'),
        youName: document.getElementById('youName'),
        youTotal: document.getElementById('youTotal'),

        row1: document.getElementById('row1'),
        row2: document.getElementById('row2'),
        row3: document.getElementById('row3'),
        rowFinal: document.getElementById('rowFinal'),

        categories: document.getElementById('categories'),
        scorecard: document.getElementById('scorecard'),

        leaderList: document.getElementById('leaderList'),
        events: document.getElementById('events'),

        winnerModal: document.getElementById('winnerModal'),
        winnerTitle: document.getElementById('winnerTitle'),
        winnerText: document.getElementById('winnerText'),
        confettiCanvas: document.getElementById('confettiCanvas'),
        categoryBanner: document.getElementById('categoryBanner'),
        phaseBanner: document.getElementById('phaseBanner'),
    };

    // Connection state
    let ws = null;
    let connected = false;
    let disconnectedAt = null;

    // UX helpers / local trackers
    let lastRenderedName = null;
    let localSel = { 1: [], 2: [], 3: [] }; // index selections per phase
    let prevRoundForSel = null;                 // last round we rendered selections for
    let categoryPending = false;                // optimistic "one-click" scoring lock
    let phaseFlipAt = 0;                        // debounce clicks ~250ms after phase flips
    let skewMs = 0; // serverNow - clientNow


    // Authoritative state (updated by server)
    let state = {
        sessionId: getStoredSessionId(),
        name: (JSON.parse(localStorage.getItem(LS_KEY)) || {}).name || '',
        youId: null,
        round: 1,
        phase: 1,
        phaseEndsAt: 0,
        phaseDice: { 1: [], 2: [], 3: [] },
        winner: null,
        restartingAt: null,
        leaderboard: [],
        events: [],
        you: {
            id: null,
            totalScore: 0,
            usedCategories: [],
            selections: { phase1: [], phase2: [], phase3: [], final: [] },
            perRoundScore: {}
        }
    };

    /** --------------------------
     * Session persistence helpers
     * ------------------------- */
    function getStoredSessionId() {
        const c = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_SESSION + '='));
        if (c) return decodeURIComponent(c.split('=')[1]);
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        return saved.sessionId || null;
    }
    function setStoredSessionId(sid) {
        try { document.cookie = `${COOKIE_SESSION}=${encodeURIComponent(sid)}; path=/; max-age=31536000; samesite=lax`; } catch { }
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        saved.sessionId = sid;
        localStorage.setItem(LS_KEY, JSON.stringify(saved));
    }
    function saveLocal() {
        const snapshot = {
            sessionId: state.sessionId,
            name: state.name,
            youId: state.youId,
            round: state.round,
            localSel
        };
        localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
    }
    function restoreSelectionsIfValid(serverRound) {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        if (!saved || saved.round !== serverRound) {
            localSel = { 1: [], 2: [], 3: [] };  // new/different round → clear
            prevRoundForSel = serverRound;
            return;
        }
        localSel = saved.localSel || { 1: [], 2: [], 3: [] };
        prevRoundForSel = serverRound;
    }

    /** --------------------------
     * WebSocket connect & messages
     * ------------------------- */
    function connect() {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            connected = true;
            disconnectedAt = null;
            els.connStatus.textContent = 'Connected';
            els.connStatus.classList.remove('lost');
            els.connStatus.classList.add('connected');

            ws.send(JSON.stringify({ type: 'hello', sessionId: state.sessionId, name: state.name || '' }));
        };

        ws.onclose = () => {
            connected = false;
            if (!disconnectedAt) disconnectedAt = Date.now();
            els.connStatus.textContent = 'Disconnected';
            els.connStatus.classList.remove('connected');
            els.connStatus.classList.add('lost');
        };

        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);

            if (msg.type === 'welcome') {
                if (msg.sessionId && msg.sessionId !== state.sessionId) {
                    state.sessionId = msg.sessionId;
                    setStoredSessionId(msg.sessionId);
                }
                state.youId = msg.youId || null;
                if (state.name) sendName(state.name);
                return;
            }

            if (msg.type === 'eventLog') {
                state.events = msg.events || [];
                renderEvents();
                return;
            }

            if (msg.type === 'tick') {
                // Lightweight updates to avoid clobbering interactive DOM
                applyPublic(msg);
                renderHeader();
                renderLeaders();
                return;
            }

            if (msg.type === 'state') {
                // Full authoritative update
                applyPublic(msg);
                if (msg.you) applyPrivate(msg.you);

                // Restore local index selections for this round (if matching)
                restoreSelectionsIfValid(state.round);

                // Clear local index picks only on real round advance (not first sync)
                if (prevRoundForSel == null) {
                    prevRoundForSel = state.round;
                } else if (prevRoundForSel !== state.round) {
                    localSel = { 1: [], 2: [], 3: [] };
                    prevRoundForSel = state.round;
                    categoryPending = false; // reset scoring lock for new round
                    saveLocal();
                }

                renderAll();
                saveLocal();
                return;
            }
        };
    }

    function applyPublic(msg) {
        const oldPhase = state.phase;

        if ('serverNow' in msg && Number.isFinite(msg.serverNow)) {
            skewMs = msg.serverNow - Date.now();
        }

        if ('round' in msg) state.round = msg.round;
        if ('phase' in msg) state.phase = msg.phase;
        if ('phaseEndsAt' in msg) state.phaseEndsAt = msg.phaseEndsAt;
        if ('phaseDice' in msg) state.phaseDice = msg.phaseDice || { 1: [], 2: [], 3: [] };
        if ('winner' in msg) state.winner = msg.winner || null;
        if ('restartingAt' in msg) state.restartingAt = msg.restartingAt || null;
        if ('leaderboard' in msg) state.leaderboard = msg.leaderboard || [];
        if ('events' in msg) state.events = msg.events || state.events;

        if (oldPhase !== state.phase) {
            phaseFlipAt = Date.now();
        }
    }


    function applyPrivate(you) {
        state.youId = you.id || state.youId;
        state.you = {
            id: you.id,
            name: state.name || '',
            totalScore: you.totalScore || 0,
            usedCategories: you.usedCategories || [],
            selections: you.selections || { phase1: [], phase2: [], phase3: [], final: [] },
            perRoundScore: you.perRoundScore || {}
        };
    }

    /** --------------------------
     * UI events
     * ------------------------- */
    els.nameForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const nm = (els.nameInput.value || '').trim().slice(0, 16);
        if (!nm) return;
        state.name = nm;
        lastRenderedName = nm;   // keep input stable after submit
        saveLocal();
        sendName(nm);
        renderYou();
    });

    /** --------------------------
     * Rendering
     * ------------------------- */
    function renderHeader() {
        const phases = { 1: 'Phase 1', 2: 'Phase 2', 3: 'Phase 3', 4: 'Scoring', 0: 'Complete' };
        els.phaseLabel.textContent = phases[state.phase] || '';
        els.roundLabel.textContent = `Round ${state.round}/15`;

        const nowAdj = Date.now() + skewMs;
        let remain = Math.max(0, Math.floor((state.phaseEndsAt - nowAdj)/1000));

        if (state.phase === 0 && state.restartingAt) {
            remain = Math.max(0, Math.floor((state.restartingAt - nowAdj)/1000));
        }
        els.timer.textContent = remain ? `${remain}s` : ':--';

        // Tag body with phase for CSS-driven emphasis
        document.body.dataset.phase = String(state.phase);

        // Show/hide scoring banner
        if (els.phaseBanner){
            els.phaseBanner.classList.toggle('hidden', state.phase !== 4);
            els.categoryBanner.classList.toggle('hidden', state.phase === 4);
        }
    }

    function dieEl(val, disabled, selected, onClick) {
        const d = document.createElement('div');
        d.className = 'die' + (disabled ? ' disabled' : '') + (selected ? ' selected' : '');
        d.textContent = String(val);
        if (!disabled && typeof onClick === 'function') d.addEventListener('click', onClick);
        return d;
    }

    // Builds preview of kept dice from local index selections
    function recomputeFinalPreview() {
        const sel = { phase1: [], phase2: [], phase3: [], final: [] };
        function addPhase(ph) {
            const dice = (state.phaseDice && state.phaseDice[ph]) ? state.phaseDice[ph] : [];
            const idxs = (localSel && localSel[ph]) ? localSel[ph] : [];
            for (let k = 0; k < idxs.length && sel.final.length < 5; k++) {
                const i = idxs[k];
                if (Number.isInteger(i) && i >= 0 && i < dice.length) {
                    const v = dice[i];
                    sel[`phase${ph}`].push(v);
                    sel.final.push(v);
                }
            }
        }
        addPhase(1); addPhase(2); addPhase(3);
        state.you = state.you || {};
        state.you.selections = sel;
    }

    function renderDice() {
        // Keep preview in sync on any full rebuild
        recomputeFinalPreview();

        const canPickPhase = (ph) => state.phase === ph;

        const toggleSelect = (phase, idx) => {
            const sel = localSel[phase] || [];
            const pos = sel.indexOf(idx);

            const totalKept =
                (localSel[1] ?.length || 0) +
                (localSel[2] ?.length || 0) +
                (localSel[3] ?.length || 0);

            if (pos >= 0) {
                sel.splice(pos, 1);
            } else {
                if (totalKept >= 5) return; // cap total kept dice
                sel.push(idx);
            }
            localSel[phase] = sel;

            // Recompute final for preview & send indices to server
            recomputeFinalPreview();
            sendSelect(phase, [...localSel[phase]]);
            saveLocal();

            // Rerender visible rows
            renderDiceRows();
            renderFinal();
        };

        function renderDiceRows() {
            [1, 2, 3].forEach(ph => {
                const row = (ph === 1) ? els.row1 : (ph === 2) ? els.row2 : els.row3;
                row.innerHTML = '';
                const dice = state.phaseDice[ph] || [];
                const chosenIdx = new Set(localSel[ph] || []);
                const disabledRow = !canPickPhase(ph) || state.phase > 3;


                dice.forEach((val, idx) => {
                    const el = dieEl(
                        val,
                        disabledRow,
                        chosenIdx.has(idx),
                        () => toggleSelect(ph, idx)
                    );
                    row.appendChild(el);
                });

                if (disabledRow) {
                    row.querySelectorAll('.die').forEach(d => d.classList.add('disabled'));
                }
            });
        }

        renderDiceRows();
        renderFinal();
    }

    function renderFinal() {
        els.rowFinal.innerHTML = '';
        const final = state.you.selections.final || [];
        final.forEach(v => {
            els.rowFinal.appendChild(dieEl(v, true, false, () => { }));
        });
    }

    function renderCategories() {
        els.categories.innerHTML = '';
        CATEGORY_ORDER.forEach(cat => {
            const used = (state.you.usedCategories || []).includes(cat);
            const btn = document.createElement('button');
            btn.className = 'cat-btn' + (used ? ' used' : '');
            btn.textContent = cat;
            btn.title = used ? 'Used this game' : 'Click to score here';
            btn.disabled = used || state.phase !== 4 || categoryPending;

            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                sendScore(cat);
            });
            els.categories.appendChild(btn);
        });
    }

    function renderScorecard() {
        els.scorecard.innerHTML = '';
        CATEGORY_ORDER.forEach(cat => {
            const catCell = document.createElement('div'); catCell.className = 'cat'; catCell.textContent = cat;
            const ptsCell = document.createElement('div'); ptsCell.className = 'pts'; ptsCell.textContent = '—';

            if ((state.you.usedCategories || []).includes(cat)) catCell.classList.add('used');

            for (const [r, info] of Object.entries(state.you.perRoundScore || {})) {
                if (info.category === cat) { ptsCell.textContent = String(info.points); break; }
            }

            const rowFrag = document.createDocumentFragment();
            rowFrag.appendChild(catCell);
            rowFrag.appendChild(ptsCell);
            els.scorecard.appendChild(rowFrag);
        });
    }

    function renderYou() {
        els.youName.textContent = state.name || 'Player';
        els.youTotal.textContent = state.you.totalScore || 0;

        // Focus-safe input updating
        const isFocused = document.activeElement === els.nameInput;
        if (!isFocused) {
            const target = state.name || '';
            if (lastRenderedName !== target) {
                els.nameInput.value = target;
                lastRenderedName = target;
            }
        }
    }

    function renderLeaders() {
        els.leaderList.innerHTML = '';
        (state.leaderboard || []).forEach(({ name, totalScore }) => {
            const li = document.createElement('li');
            li.textContent = `${name}: ${totalScore}`;
            els.leaderList.appendChild(li);
        });
    }

    function renderEvents() {
        els.events.innerHTML = '';
        (state.events || []).slice(-200).forEach(ev => {
            const line = document.createElement('div');
            line.className = 'event';
            const t = new Date(ev.ts);
            const hh = String(t.getHours()).padStart(2, '0');
            const mm = String(t.getMinutes()).padStart(2, '0');
            const ss = String(t.getSeconds()).padStart(2, '0');
            line.innerHTML = `<time>[${hh}:${mm}:${ss}]</time>${escapeHtml(ev.text)}`;
            els.events.appendChild(line);
        });
        els.events.scrollTop = els.events.scrollHeight;
    }

    function renderWinner() {
        if (state.winner && state.phase === 0) {
            els.winnerTitle.textContent = 'Winner!';
            els.winnerText.textContent = `${state.winner.name} with ${state.winner.totalScore} points`;
            els.winnerModal.classList.remove('hidden');
            startConfetti();
        } else {
            els.winnerModal.classList.add('hidden');
            stopConfetti();
        }
    }

    function renderAll() {
        renderHeader();
        renderYou();
        renderDice();
        renderCategories();
        renderScorecard();
        renderLeaders();
        renderEvents();
        renderWinner();
    }

    /** --------------------------
     * Senders
     * ------------------------- */
    function sendSelect(phase, indices) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'selectDice', phase, indices }));
    }
    function sendScore(category) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (categoryPending) return;

        // Optimistic lock and feedback
        categoryPending = true;
        if (!state.you.usedCategories.includes(category)) {
            state.you.usedCategories = [...state.you.usedCategories, category];
        }
        renderCategories();

        ws.send(JSON.stringify({ type: 'scoreCategory', category }));

        // Safety unlock if echo is slow; server 'state' will also update
        setTimeout(() => { categoryPending = false; renderCategories(); }, 2000);
    }
    function sendName(nm) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'setName', name: nm }));
        }
    }

    /** --------------------------
     * Timers
     * ------------------------- */
    // Countdown + auto-refresh on long disconnect
    setInterval(() => {
        renderHeader();
        if (!connected && disconnectedAt && Date.now() - disconnectedAt > 10_000) {
            location.reload();
        }
    }, 500);

    /** --------------------------
     * Confetti (simple, no deps)
     * ------------------------- */
    let confettiRAF = null;
    let confettiParticles = [];
    function startConfetti() {
        const canvas = els.confettiCanvas;
        const ctx = canvas.getContext('2d');
        resizeCanvas();

        confettiParticles = new Array(220).fill(0).map(() => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 2,
            vy: Math.random() * -2 - 1,
            r: Math.random() * 3 + 2,
            a: 1
        }));

        function tick() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            confettiParticles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.03;   // gravity
                p.a -= 0.007;
                if (p.y > canvas.height) { p.y = -10; p.vy = Math.random() * -2 - 1; }
                if (p.x < 0) p.x = canvas.width;
                if (p.x > canvas.width) p.x = 0;
                ctx.globalAlpha = Math.max(0, p.a);
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
            });
            ctx.globalAlpha = 1;
            confettiRAF = requestAnimationFrame(tick);
        }
        if (!confettiRAF) tick();

        window.addEventListener('resize', resizeCanvas);
        function resizeCanvas() {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
        }
    }
    function stopConfetti() {
        if (confettiRAF) cancelAnimationFrame(confettiRAF);
        confettiRAF = null;
        confettiParticles = [];
    }

    /** --------------------------
     * Utils
     * ------------------------- */
    function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    function adjustHeaderOffset(){
        const h = document.querySelector('.app-header');
        if (!h) return;
        const px = h.offsetHeight + 'px';
        document.body.style.setProperty('--app-header-h', px);
    }

    window.addEventListener('load', adjustHeaderOffset);
    window.addEventListener('resize', adjustHeaderOffset);
    window.addEventListener('orientationchange', adjustHeaderOffset);
    document.addEventListener('visibilitychange', adjustHeaderOffset);
    /** --------------------------
     * Boot
     * ------------------------- */

    connect();
    renderAll();
})();
