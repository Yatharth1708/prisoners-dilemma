/**
 * Prisoner's Dilemma — Multiplayer Server
 *
 * Architecture:
 *   • 2 players join a lobby by entering their name.
 *   • Once both are in, the game starts with a RANDOM number of rounds (3-10).
 *   • Players do NOT know how many rounds remain (hidden).
 *   • Each round both players pick "collaborate" or "defect" simultaneously.
 *   • Choices are hidden from each other until both have submitted.
 *   • Scores are NOT shown during the game — only revealed at the end.
 *   • After all rounds, a final ranking screen is shown to both players.
 *
 * Extendable to 10 pairs later by using room-based architecture.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════════
   PAYOFF MATRIX
   ═══════════════════════════════════════════════ */
const PAYOFF = {
    collaborate: { collaborate: [3, 3], defect: [0, 5] },
    defect:      { collaborate: [5, 0], defect: [1, 1] },
};

/* ═══════════════════════════════════════════════
   GAME ROOMS — keyed by roomCode
   ═══════════════════════════════════════════════ */
const rooms = {}; // { [roomCode]: RoomState }

function createRoom(code) {
    const totalRounds = Math.floor(Math.random() * 8) + 3; // 3-10
    return {
        code,
        players: [],          // [{ id, name, socketId }]
        totalRounds,
        currentRound: 0,
        rounds: [],           // [{ choices: { [playerId]: choice }, results: { [playerId]: pts } }]
        scores: {},           // { [playerId]: totalScore }
        state: 'waiting',     // waiting | playing | finished
    };
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms[code] ? generateRoomCode() : code;
}

/* ═══════════════════════════════════════════════
   SOCKET HANDLING
   ═══════════════════════════════════════════════ */
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    /* ── CREATE ROOM ── */
    socket.on('create-room', ({ playerName }, callback) => {
        const code = generateRoomCode();
        const room = createRoom(code);
        const player = { id: 'P1', name: playerName, socketId: socket.id };
        room.players.push(player);
        room.scores[player.id] = 0;
        rooms[code] = room;

        socket.join(code);
        socket.data = { roomCode: code, playerId: 'P1' };

        callback({ success: true, roomCode: code, playerId: 'P1' });
        console.log(`[ROOM] ${playerName} created room ${code}`);
    });

    /* ── JOIN ROOM ── */
    socket.on('join-room', ({ roomCode, playerName }, callback) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];

        if (!room) return callback({ success: false, error: 'Room not found.' });
        if (room.players.length >= 2) return callback({ success: false, error: 'Room is full.' });
        if (room.state !== 'waiting') return callback({ success: false, error: 'Game already in progress.' });

        const player = { id: 'P2', name: playerName, socketId: socket.id };
        room.players.push(player);
        room.scores[player.id] = 0;

        socket.join(code);
        socket.data = { roomCode: code, playerId: 'P2' };

        callback({ success: true, roomCode: code, playerId: 'P2' });
        console.log(`[ROOM] ${playerName} joined room ${code}`);

        // Both players are in — start the game
        startGame(code);
    });

    /* ── SUBMIT CHOICE ── */
    socket.on('submit-choice', ({ choice }, callback) => {
        const { roomCode, playerId } = socket.data || {};
        if (!roomCode || !playerId) return callback({ success: false, error: 'Not in a room.' });

        const room = rooms[roomCode];
        if (!room || room.state !== 'playing') return callback({ success: false, error: 'Game not active.' });

        const roundIdx = room.currentRound - 1;
        const round = room.rounds[roundIdx];

        if (round.choices[playerId]) return callback({ success: false, error: 'Already submitted.' });
        if (!['collaborate', 'defect'].includes(choice)) return callback({ success: false, error: 'Invalid choice.' });

        round.choices[playerId] = choice;
        callback({ success: true });

        // Notify opponent that this player has locked in (without revealing choice)
        const opponent = room.players.find(p => p.id !== playerId);
        if (opponent) {
            io.to(opponent.socketId).emit('opponent-locked');
        }

        console.log(`[CHOICE] Room ${roomCode} Round ${room.currentRound}: ${playerId} chose ${choice}`);

        // If both submitted, resolve round
        if (round.choices['P1'] && round.choices['P2']) {
            resolveRound(roomCode);
        }
    });

    /* ── DISCONNECT ── */
    socket.on('disconnect', () => {
        const { roomCode, playerId } = socket.data || {};
        if (roomCode && rooms[roomCode]) {
            const room = rooms[roomCode];
            // Notify the other player
            io.to(roomCode).emit('player-disconnected', {
                name: room.players.find(p => p.id === playerId)?.name || 'Opponent',
            });
            // Clean up
            if (room.state !== 'finished') {
                delete rooms[roomCode];
                console.log(`[ROOM] Room ${roomCode} deleted (player disconnected)`);
            }
        }
        console.log(`[-] Disconnected: ${socket.id}`);
    });
});

/* ═══════════════════════════════════════════════
   GAME LOGIC
   ═══════════════════════════════════════════════ */
function startGame(roomCode) {
    const room = rooms[roomCode];
    room.state = 'playing';
    room.currentRound = 0;

    // Tell both players the game has started (names, NOT round count)
    io.to(roomCode).emit('game-started', {
        players: room.players.map(p => ({ id: p.id, name: p.name })),
    });

    nextRound(roomCode);
}

function nextRound(roomCode) {
    const room = rooms[roomCode];
    room.currentRound++;
    room.rounds.push({ choices: {}, results: {} });

    io.to(roomCode).emit('new-round', {
        roundNumber: room.currentRound,
    });

    console.log(`[ROUND] Room ${roomCode} — Round ${room.currentRound} started`);
}

function resolveRound(roomCode) {
    const room = rooms[roomCode];
    const roundIdx = room.currentRound - 1;
    const round = room.rounds[roundIdx];

    const choiceP1 = round.choices['P1'];
    const choiceP2 = round.choices['P2'];
    const [ptsP1, ptsP2] = PAYOFF[choiceP1][choiceP2];

    round.results = { P1: ptsP1, P2: ptsP2 };
    room.scores['P1'] += ptsP1;
    room.scores['P2'] += ptsP2;

    // Send round result to both players (show choices + round points, but NOT cumulative score)
    io.to(roomCode).emit('round-result', {
        roundNumber: room.currentRound,
        choices: { P1: choiceP1, P2: choiceP2 },
        points: { P1: ptsP1, P2: ptsP2 },
    });

    console.log(`[RESULT] Room ${roomCode} Round ${room.currentRound}: P1=${choiceP1}(+${ptsP1}) P2=${choiceP2}(+${ptsP2})`);

    // Check if game is over
    if (room.currentRound >= room.totalRounds) {
        setTimeout(() => endGame(roomCode), 2000);
    } else {
        setTimeout(() => nextRound(roomCode), 2500);
    }
}

function endGame(roomCode) {
    const room = rooms[roomCode];
    room.state = 'finished';

    const results = room.players.map(p => ({
        id: p.id,
        name: p.name,
        score: room.scores[p.id],
    })).sort((a, b) => b.score - a.score);

    // Build round history for final display
    const history = room.rounds.map((r, i) => ({
        round: i + 1,
        choices: r.choices,
        points: r.results,
    }));

    io.to(roomCode).emit('game-over', {
        results,
        totalRounds: room.totalRounds,
        history,
    });

    console.log(`[END] Room ${roomCode} — Final: ${results.map(r => `${r.name}:${r.score}`).join(' vs ')}`);

    // Clean up room after a delay
    setTimeout(() => {
        delete rooms[roomCode];
        console.log(`[ROOM] Room ${roomCode} cleaned up`);
    }, 60000);
}

/* ═══════════════════════════════════════════════
   START SERVER
   ═══════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🎲 Prisoner's Dilemma server running on http://localhost:${PORT}\n`);
});
