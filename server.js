const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 25000,
    pingTimeout: 60000,
    transports: ['websocket', 'polling'],
    connectionStateRecovery: {
        maxDisconnectionDuration: 5 * 60 * 1000,
        skipMiddlewares: true
    }
});
app.use(express.static(path.join(__dirname, 'public')));
var MAX_PLAYERS = 20;
var TOTAL_ROUNDS = 20;
var ROUND_DURATION_SEC = 10;
var PAYOFF = {
    collaborate: { collaborate: [3, 3], defect: [0, 5] },
    defect: { collaborate: [5, 0], defect: [1, 1] },
};
var rooms = {};
var REJOIN_GRACE_MS = 5 * 60 * 1000;
function generateSessionToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms[code] ? generateRoomCode() : code;
}
function createRoom(code, hostSocketId, maxPlayers) {
    return { code: code, hostSocketId: hostSocketId, players: [], pairs: [], totalRounds: TOTAL_ROUNDS, roundDurationSec: ROUND_DURATION_SEC, maxPlayers: maxPlayers || MAX_PLAYERS, currentRound: 0, rounds: [], scores: {}, state: 'waiting' };
}
function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
}
function broadcastPlayerList(roomCode) {
    var room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('player-list', {
        players: room.players.map(function(p) { return { id: p.id, name: p.name }; }),
        hostId: room.players.length > 0 ? room.players[0].id : null,
        maxPlayers: room.maxPlayers,
    });
}
io.on('connection', function(socket) {
    if (socket.recovered) {
        // Socket.IO transparently restored socket.data, socket.rooms, and missed packets.
        var sd2 = socket.data || {};
        if (sd2.roomCode && rooms[sd2.roomCode]) {
            var r2 = rooms[sd2.roomCode];
            var p2 = r2.players.find(function(p) { return p.id === sd2.playerId; });
            if (p2) {
                if (p2.pendingDisconnect) { clearTimeout(p2.pendingDisconnect); p2.pendingDisconnect = null; }
                p2.socketId = socket.id;
                if (r2.players[0] && r2.players[0].id === p2.id) r2.hostSocketId = socket.id;
                console.log('[room ' + sd2.roomCode + '] socket recovered for ' + p2.name);
            }
        }
    }
    socket.on('create-room', function(data, callback) {
        var code = generateRoomCode();
        var maxPlayers = parseInt(data && data.maxPlayers) || MAX_PLAYERS;
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers % 2 !== 0) maxPlayers = maxPlayers + 1; // ensure even
        if (maxPlayers > 100) maxPlayers = 100;
        var room = createRoom(code, socket.id, maxPlayers);
        var playerId = 'P1';
        var sessionToken = generateSessionToken();
        room.players.push({ id: playerId, name: data.playerName.trim(), socketId: socket.id, sessionToken: sessionToken });
        room.scores[playerId] = 0;
        rooms[code] = room;
        socket.join(code);
        socket.data = { roomCode: code, playerId: playerId };
        callback({ success: true, roomCode: code, playerId: playerId, sessionToken: sessionToken });
        broadcastPlayerList(code);
    });
    socket.on('join-room', function(data, callback) {
        var code = data.roomCode.toUpperCase().trim();
        var room = rooms[code];
        if (!room) return callback({ success: false, error: 'Room not found.' });
        if (room.players.length >= room.maxPlayers) return callback({ success: false, error: 'Room is full (max ' + room.maxPlayers + ').' });
        if (room.state !== 'waiting') return callback({ success: false, error: 'Game already in progress.' });
        var trimName = data.playerName.trim();
        // Auto-disambiguate duplicate names by appending a numeric suffix.
        var finalName = trimName;
        var suffix = 2;
        while (room.players.some(function(p) { return p.name.toLowerCase() === finalName.toLowerCase(); })) {
            finalName = trimName + ' (' + suffix + ')';
            suffix++;
        }
        var playerId = 'P' + (room.players.length + 1);
        var sessionToken = generateSessionToken();
        room.players.push({ id: playerId, name: finalName, socketId: socket.id, sessionToken: sessionToken });
        room.scores[playerId] = 0;
        socket.join(code);
        socket.data = { roomCode: code, playerId: playerId };
        callback({ success: true, roomCode: code, playerId: playerId, sessionToken: sessionToken, playerName: finalName });
        broadcastPlayerList(code);
    });
    socket.on('start-game', function(data, callback) {
        var sd = socket.data || {};
        var room = rooms[sd.roomCode];
        if (!room) return callback({ success: false, error: 'Room not found.' });
        if (room.hostSocketId !== socket.id) return callback({ success: false, error: 'Only the host can start.' });
        if (room.players.length < 2) return callback({ success: false, error: 'Need at least 2 players.' });
        if (room.players.length % 2 !== 0) return callback({ success: false, error: 'Need even number of players (currently ' + room.players.length + ').' });
        if (room.state !== 'waiting') return callback({ success: false, error: 'Game already started.' });
        var rounds = parseInt(data && data.rounds) || TOTAL_ROUNDS;
        if (rounds < 1) rounds = 1;
        if (rounds > 100) rounds = 100;
        room.totalRounds = rounds;
        var roundDuration = parseInt(data && data.roundDuration) || ROUND_DURATION_SEC;
        if (roundDuration < 3) roundDuration = 3;
        if (roundDuration > 120) roundDuration = 120;
        room.roundDurationSec = roundDuration;
        room.hostEmail = (data && data.email) ? data.email.trim() : '';
        callback({ success: true });
        startGame(sd.roomCode);
    });
    socket.on('submit-choice', function(data, callback) {
        var sd = socket.data || {};
        if (!sd.roomCode || !sd.playerId) return callback({ success: false, error: 'Not in a room.' });
        var room = rooms[sd.roomCode];
        if (!room || room.state !== 'playing') return callback({ success: false, error: 'Game not active.' });
        var round = room.rounds[room.currentRound - 1];
        if (round.choices[sd.playerId]) return callback({ success: false, error: 'Already submitted.' });
        if (data.choice !== 'collaborate' && data.choice !== 'defect') return callback({ success: false, error: 'Invalid choice.' });
        round.choices[sd.playerId] = data.choice;
        callback({ success: true });
        var pair = room.pairs.find(function(p) { return p.playerA === sd.playerId || p.playerB === sd.playerId; });
        if (pair) {
            var oppId = pair.playerA === sd.playerId ? pair.playerB : pair.playerA;
            var opp = room.players.find(function(p) { return p.id === oppId; });
            if (opp) io.to(opp.socketId).emit('opponent-locked');
        }
        checkRoundComplete(sd.roomCode);
    });
    socket.on('rejoin-room', function(data, callback) {
        var code = (data && data.roomCode || '').toUpperCase().trim();
        var room = rooms[code];
        if (!room) return callback({ success: false, error: 'Room no longer exists.' });
        if (!data || !data.sessionToken) return callback({ success: false, error: 'Missing session token.' });
        var player = room.players.find(function(p) { return p.sessionToken === data.sessionToken; });
        if (!player) return callback({ success: false, error: 'Session not found.' });
        if (room.state === 'finished') return callback({ success: false, error: 'Game already finished.' });
        if (player.pendingDisconnect) { clearTimeout(player.pendingDisconnect); player.pendingDisconnect = null; }
        player.socketId = socket.id;
        player.isBot = false;
        var wasHost = room.players.length > 0 && room.players[0].id === player.id;
        if (wasHost) room.hostSocketId = socket.id;
        socket.join(code);
        socket.data = { roomCode: code, playerId: player.id };
        if (room.state === 'waiting') {
            callback({ success: true, state: 'waiting', roomCode: code, playerId: player.id, playerName: player.name, isHost: wasHost, maxPlayers: room.maxPlayers });
            broadcastPlayerList(code);
            return;
        }
        // playing — send full snapshot so client can restore the game screen.
        var pair = room.pairs.find(function(pr) { return pr.playerA === player.id || pr.playerB === player.id; });
        var pairNumber = pair ? room.pairs.indexOf(pair) + 1 : 0;
        var oppId = pair ? (pair.playerA === player.id ? pair.playerB : pair.playerA) : null;
        var opp = oppId ? room.players.find(function(pl) { return pl.id === oppId; }) : null;
        var history = [];
        for (var i = 0; i < room.rounds.length; i++) {
            var rr = room.rounds[i];
            if (!rr.resolved) continue;
            var myC = rr.choices[player.id];
            var opC = oppId ? rr.choices[oppId] : null;
            if (!myC || !opC) continue;
            var pts = PAYOFF[myC][opC];
            history.push({ round: i + 1, myChoice: myC, opChoice: opC, myPts: pts[0], opPts: pts[1] });
        }
        var curRound = room.rounds[room.currentRound - 1];
        var roundActive = !!(curRound && !curRound.resolved && room.roundTimer);
        var alreadySubmitted = !!(curRound && curRound.choices[player.id]);
        var remainingMs = 0;
        if (roundActive && curRound.startedAt) {
            remainingMs = Math.max(0, room.roundDurationSec * 1000 - (Date.now() - curRound.startedAt));
        }
        callback({
            success: true,
            state: 'playing',
            roomCode: code,
            playerId: player.id,
            playerName: player.name,
            isHost: wasHost,
            pairNumber: pairNumber,
            totalPairs: room.pairs.length,
            totalPlayers: room.players.length,
            opponent: opp ? { id: opp.id, name: opp.name, isBot: !!opp.isBot } : null,
            totalRounds: room.totalRounds,
            currentRound: room.currentRound,
            history: history,
            myScore: room.scores[player.id] || 0,
            oppScore: oppId ? (room.scores[oppId] || 0) : 0,
            roundActive: roundActive,
            alreadySubmitted: alreadySubmitted,
            roundDurationSec: room.roundDurationSec,
            remainingMs: remainingMs
        });
    });
    socket.on('disconnect', function() {
        var sd = socket.data || {};
        if (!sd.roomCode || !rooms[sd.roomCode]) return;
        var room = rooms[sd.roomCode];
        var player = room.players.find(function(p) { return p.id === sd.playerId; });
        if (!player) return;
        // Ignore stale disconnects: if a newer socket has already taken over for this player
        // (e.g., page refresh or Socket.IO auto-reconnect raced ahead of the old socket's close),
        // do NOT null out the new socketId or start the grace timer.
        if (player.socketId && player.socketId !== socket.id) return;
        var playerName = player.name;
        var wasHost = room.hostSocketId === socket.id;
        player.socketId = null;
        if (player.pendingDisconnect) clearTimeout(player.pendingDisconnect);
        if (room.state === 'waiting') {
            // Grace period to allow rejoin after refresh / transient network blip.
            player.pendingDisconnect = setTimeout(function() {
                var r = rooms[sd.roomCode];
                if (!r) return;
                var p = r.players.find(function(pl) { return pl.id === sd.playerId; });
                if (!p || p.socketId) return; // already rejoined
                if (wasHost) {
                    // Host grace expired. Instead of killing the whole room, promote the next
                    // player in join order to host so everyone else can continue. The room is
                    // only torn down if no players remain.
                    r.players = r.players.filter(function(pl) { return pl.id !== sd.playerId; });
                    delete r.scores[sd.playerId];
                    if (r.players.length === 0) {
                        console.log('[room ' + sd.roomCode + '] empty after host left; deleting.');
                        delete rooms[sd.roomCode];
                        return;
                    }
                    var newHost = r.players[0];
                    r.hostSocketId = newHost.socketId || null;
                    console.log('[room ' + sd.roomCode + '] host ' + playerName + ' did not return; promoted ' + newHost.name + ' to host.');
                    broadcastPlayerList(sd.roomCode);
                } else {
                    console.log('[room ' + sd.roomCode + '] player ' + playerName + ' did not return; removed from lobby.');
                    r.players = r.players.filter(function(pl) { return pl.id !== sd.playerId; });
                    delete r.scores[sd.playerId];
                    broadcastPlayerList(sd.roomCode);
                }
            }, REJOIN_GRACE_MS);
            return;
        }
        if (room.state === 'playing') {
            // Grace period before botifying the player; the round timer will still cover any
            // un-submitted choice via random fallback. Host is treated like any other player
            // during play so transient disconnects don't kill the room.
            player.pendingDisconnect = setTimeout(function() {
                var r = rooms[sd.roomCode];
                if (!r || r.state !== 'playing') return;
                var p = r.players.find(function(pl) { return pl.id === sd.playerId; });
                if (!p || p.socketId) return; // already rejoined
                p.isBot = true;
                var pair = r.pairs.find(function(pr) { return pr.playerA === p.id || pr.playerB === p.id; });
                if (pair) {
                    var oppId = pair.playerA === p.id ? pair.playerB : pair.playerA;
                    var opp = r.players.find(function(pl) { return pl.id === oppId; });
                    if (opp && opp.socketId) io.to(opp.socketId).emit('opponent-disconnected-bot', { name: playerName });
                }
                submitBotChoices(sd.roomCode);
            }, REJOIN_GRACE_MS);
        }
    });
});
function startGame(roomCode) {
    var room = rooms[roomCode];
    var ids = shuffle(room.players.map(function(p) { return p.id; }));
    room.pairs = [];
    for (var i = 0; i < ids.length; i += 2) { room.pairs.push({ playerA: ids[i], playerB: ids[i + 1] }); }
    room.state = 'playing';
    room.currentRound = 0;
    room.pairs.forEach(function(pair, idx) {
        var pA = room.players.find(function(p) { return p.id === pair.playerA; });
        var pB = room.players.find(function(p) { return p.id === pair.playerB; });
        function mp(you, opp) { return { pairNumber: idx + 1, totalPairs: room.pairs.length, totalPlayers: room.players.length, you: { id: you.id, name: you.name }, opponent: { id: opp.id, name: opp.name } }; }
        if (pA) io.to(pA.socketId).emit('game-started', mp(pA, pB));
        if (pB) io.to(pB.socketId).emit('game-started', mp(pB, pA));
    });
    nextRound(roomCode);
}
function nextRound(roomCode) {
    var room = rooms[roomCode];
    room.currentRound++;
    room.rounds.push({ choices: {}, startedAt: Date.now(), resolved: false });
    io.to(roomCode).emit('new-round', { roundNumber: room.currentRound, durationSec: room.roundDurationSec });
    // Auto-submit for bot players
    submitBotChoices(roomCode);
    // Start round timer: when it expires, auto-submit random choices for any player who hasn't locked in.
    if (room.roundTimer) clearTimeout(room.roundTimer);
    var capturedRound = room.currentRound;
    room.roundTimer = setTimeout(function() {
        var r = rooms[roomCode];
        if (!r || r.state !== 'playing' || r.currentRound !== capturedRound) return;
        var round = r.rounds[r.currentRound - 1];
        if (!round) return;
        r.players.forEach(function(p) {
            if (!round.choices[p.id]) {
                round.choices[p.id] = Math.random() < 0.5 ? 'collaborate' : 'defect';
                if (p.socketId) io.to(p.socketId).emit('choice-auto-submitted', { choice: round.choices[p.id] });
                var pair = r.pairs.find(function(pr) { return pr.playerA === p.id || pr.playerB === p.id; });
                if (pair) {
                    var oppId = pair.playerA === p.id ? pair.playerB : pair.playerA;
                    var opp = r.players.find(function(pl) { return pl.id === oppId; });
                    if (opp && opp.socketId) io.to(opp.socketId).emit('opponent-locked');
                }
            }
        });
        checkRoundComplete(roomCode);
    }, room.roundDurationSec * 1000);
}
function submitBotChoices(roomCode) {
    var room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;
    var round = room.rounds[room.currentRound - 1];
    if (!round) return;
    var submitted = false;
    room.players.forEach(function(p) {
        if (p.isBot && !round.choices[p.id]) {
            round.choices[p.id] = Math.random() < 0.5 ? 'collaborate' : 'defect';
            submitted = true;
            // Notify opponent that bot has locked in
            var pair = room.pairs.find(function(pr) { return pr.playerA === p.id || pr.playerB === p.id; });
            if (pair) {
                var oppId = pair.playerA === p.id ? pair.playerB : pair.playerA;
                var opp = room.players.find(function(pl) { return pl.id === oppId; });
                if (opp && opp.socketId) io.to(opp.socketId).emit('opponent-locked');
            }
        }
    });
    if (submitted) checkRoundComplete(roomCode);
}
function checkRoundComplete(roomCode) {
    var room = rooms[roomCode];
    var round = room.rounds[room.currentRound - 1];
    var done = room.pairs.every(function(pair) { return round.choices[pair.playerA] && round.choices[pair.playerB]; });
    if (done) resolveRound(roomCode);
}
function resolveRound(roomCode) {
    var room = rooms[roomCode];
    if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
    var round = room.rounds[room.currentRound - 1];
    round.resolved = true;
    room.pairs.forEach(function(pair) {
        var cA = round.choices[pair.playerA]; var cB = round.choices[pair.playerB];
        var pts = PAYOFF[cA][cB];
        room.scores[pair.playerA] += pts[0]; room.scores[pair.playerB] += pts[1];
        var pA = room.players.find(function(p) { return p.id === pair.playerA; });
        var pB = room.players.find(function(p) { return p.id === pair.playerB; });
        if (pA) io.to(pA.socketId).emit('round-result', { roundNumber: room.currentRound, yourChoice: cA, oppChoice: cB, yourPts: pts[0], oppPts: pts[1], oppName: pB ? pB.name : '?' });
        if (pB) io.to(pB.socketId).emit('round-result', { roundNumber: room.currentRound, yourChoice: cB, oppChoice: cA, yourPts: pts[1], oppPts: pts[0], oppName: pA ? pA.name : '?' });
    });
    if (room.currentRound >= room.totalRounds) { setTimeout(function() { endGame(roomCode); }, 2500); }
    else { setTimeout(function() { nextRound(roomCode); }, 2500); }
}
function endGame(roomCode) {
    var room = rooms[roomCode];
    room.state = 'finished';
    var leaderboard = room.players.map(function(p) {
        var pair = room.pairs.find(function(pr) { return pr.playerA === p.id || pr.playerB === p.id; });
        var oppId = pair.playerA === p.id ? pair.playerB : pair.playerA;
        var opp = room.players.find(function(pl) { return pl.id === oppId; });
        return { id: p.id, name: p.isBot ? p.name + ' (Bot)' : p.name, score: room.scores[p.id], pairNumber: room.pairs.indexOf(pair) + 1, opponentName: opp ? (opp.isBot ? opp.name + ' (Bot)' : opp.name) : '?' };
    }).sort(function(a, b) { return b.score - a.score; });
    // Build allPairsHistory for CSV
    var allPairsHistory = [];
    room.rounds.forEach(function(r, ri) {
        room.pairs.forEach(function(pair, pi) {
            var pA = room.players.find(function(p) { return p.id === pair.playerA; });
            var pB = room.players.find(function(p) { return p.id === pair.playerB; });
            var cA = r.choices[pair.playerA]; var cB = r.choices[pair.playerB];
            var pts = PAYOFF[cA][cB];
            allPairsHistory.push({ round: ri + 1, pair: pi + 1, playerA: pA ? pA.name : '?', choiceA: cA, playerB: pB ? pB.name : '?', choiceB: cB, ptsA: pts[0], ptsB: pts[1] });
        });
    });
    room.players.forEach(function(p) {
        var pair = room.pairs.find(function(pr) { return pr.playerA === p.id || pr.playerB === p.id; });
        var oppId = pair.playerA === p.id ? pair.playerB : pair.playerA;
        var opp = room.players.find(function(pl) { return pl.id === oppId; });
        var history = room.rounds.map(function(r, i) {
            var myC = r.choices[p.id]; var opC = r.choices[oppId];
            var myPts = PAYOFF[myC][opC];
            return { round: i + 1, myChoice: myC, opChoice: opC, myPts: myPts[0], opPts: myPts[1] };
        });
        io.to(p.socketId).emit('game-over', { leaderboard: leaderboard, totalRounds: room.totalRounds, myId: p.id, history: history, opponentName: opp ? opp.name : '?', allPairsHistory: allPairsHistory });
    });
    // Email CSV to host if email provided
    if (room.hostEmail) {
        sendResultsEmail(room.hostEmail, leaderboard, allPairsHistory, room.totalRounds);
    }
    setTimeout(function() { delete rooms[roomCode]; }, 120000);
}
function generateCSV(leaderboard, allPairsHistory, totalRounds) {
    var pairs = {};
    allPairsHistory.forEach(function(r) {
        if (!pairs[r.pair]) pairs[r.pair] = { playerA: r.playerA, playerB: r.playerB, rounds: [] };
        pairs[r.pair].rounds.push(r);
    });
    var pairKeys = Object.keys(pairs).sort(function(a, b) { return a - b; });
    var maxR = 0;
    pairKeys.forEach(function(k) { if (pairs[k].rounds.length > maxR) maxR = pairs[k].rounds.length; });
    var header = ['', ''];
    for (var i = 1; i <= maxR; i++) header.push('R' + i);
    header.push('Total C', 'Total E', 'Points');
    var rows = [header];
    pairKeys.forEach(function(k) {
        var p = pairs[k];
        p.rounds.sort(function(a, b) { return a.round - b.round; });
        var aChoices = [], bChoices = [], aPts = 0, bPts = 0, aC = 0, aD = 0, bC = 0, bD = 0;
        p.rounds.forEach(function(r) {
            var ca = r.choiceA === 'collaborate' ? 'C' : 'E';
            var cb = r.choiceB === 'collaborate' ? 'C' : 'E';
            aChoices.push(ca); bChoices.push(cb);
            aPts += r.ptsA; bPts += r.ptsB;
            if (ca === 'C') aC++; else aD++;
            if (cb === 'C') bC++; else bD++;
        });
        var rowA = ['Pair ' + k, p.playerA];
        var rowB = ['', p.playerB];
        for (var i = 0; i < maxR; i++) { rowA.push(i < aChoices.length ? aChoices[i] : ''); rowB.push(i < bChoices.length ? bChoices[i] : ''); }
        rowA.push(aC, aD, aPts); rowB.push(bC, bD, bPts);
        rows.push(rowA); rows.push(rowB); rows.push([]);
    });
    return rows.map(function(r) { return r.map(function(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
}
function sendResultsEmail(email, leaderboard, allPairsHistory, totalRounds) {
    var smtpHost = process.env.SMTP_HOST;
    var smtpPort = process.env.SMTP_PORT || 587;
    var smtpUser = process.env.SMTP_USER;
    var smtpPass = process.env.SMTP_PASS;
    var smtpFrom = process.env.SMTP_FROM || smtpUser;
    if (!smtpHost || !smtpUser || !smtpPass) {
        console.log('SMTP not configured. Skipping email to ' + email);
        return;
    }
    var transporter = nodemailer.createTransport({ host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465, auth: { user: smtpUser, pass: smtpPass } });
    var csv = generateCSV(leaderboard, allPairsHistory, totalRounds);
    var winner = leaderboard[0] ? leaderboard[0].name : 'N/A';
    transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: 'Dilemma Game Results - Winner: ' + winner,
        text: 'Game results attached.\n\nLeaderboard:\n' + leaderboard.map(function(r, i) { return (i + 1) + '. ' + r.name + ' - ' + r.score + ' pts (vs ' + r.opponentName + ')'; }).join('\n'),
        attachments: [{ filename: 'dilemma-results.csv', content: csv, contentType: 'text/csv' }]
    }, function(err) {
        if (err) console.log('Email error:', err.message);
        else console.log('Results emailed to ' + email);
    });
}
var PORT = process.env.PORT || 3000;
server.listen(PORT, function() { console.log('Server on http://localhost:' + PORT); });
