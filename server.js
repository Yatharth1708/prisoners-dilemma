const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
var MAX_PLAYERS = 20;
var TOTAL_ROUNDS = 20;
var PAYOFF = {
    collaborate: { collaborate: [3, 3], defect: [0, 5] },
    defect: { collaborate: [5, 0], defect: [1, 1] },
};
var rooms = {};
function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms[code] ? generateRoomCode() : code;
}
function createRoom(code, hostSocketId) {
    return { code: code, hostSocketId: hostSocketId, players: [], pairs: [], totalRounds: TOTAL_ROUNDS, currentRound: 0, rounds: [], scores: {}, state: 'waiting' };
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
        maxPlayers: MAX_PLAYERS,
    });
}
io.on('connection', function(socket) {
    socket.on('create-room', function(data, callback) {
        var code = generateRoomCode();
        var room = createRoom(code, socket.id);
        var playerId = 'P1';
        room.players.push({ id: playerId, name: data.playerName.trim(), socketId: socket.id });
        room.scores[playerId] = 0;
        rooms[code] = room;
        socket.join(code);
        socket.data = { roomCode: code, playerId: playerId };
        callback({ success: true, roomCode: code, playerId: playerId });
        broadcastPlayerList(code);
    });
    socket.on('join-room', function(data, callback) {
        var code = data.roomCode.toUpperCase().trim();
        var room = rooms[code];
        if (!room) return callback({ success: false, error: 'Room not found.' });
        if (room.players.length >= MAX_PLAYERS) return callback({ success: false, error: 'Room is full (max 20).' });
        if (room.state !== 'waiting') return callback({ success: false, error: 'Game already in progress.' });
        var trimName = data.playerName.trim();
        var dup = room.players.some(function(p) { return p.name.toLowerCase() === trimName.toLowerCase(); });
        if (dup) return callback({ success: false, error: 'Name already taken.' });
        var playerId = 'P' + (room.players.length + 1);
        room.players.push({ id: playerId, name: trimName, socketId: socket.id });
        room.scores[playerId] = 0;
        socket.join(code);
        socket.data = { roomCode: code, playerId: playerId };
        callback({ success: true, roomCode: code, playerId: playerId });
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
    socket.on('disconnect', function() {
        var sd = socket.data || {};
        if (sd.roomCode && rooms[sd.roomCode]) {
            var room = rooms[sd.roomCode];
            var player = room.players.find(function(p) { return p.id === sd.playerId; });
            var playerName = player ? player.name : 'A player';
            if (room.state === 'waiting') {
                room.players = room.players.filter(function(p) { return p.id !== sd.playerId; });
                delete room.scores[sd.playerId];
                if (room.hostSocketId === socket.id) {
                    if (room.players.length > 0) { room.hostSocketId = room.players[0].socketId; }
                    else { delete rooms[sd.roomCode]; return; }
                }
                broadcastPlayerList(sd.roomCode);
            } else if (room.state === 'playing') {
                io.to(sd.roomCode).emit('player-disconnected', { name: playerName });
                delete rooms[sd.roomCode];
            }
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
    room.rounds.push({ choices: {} });
    io.to(roomCode).emit('new-round', { roundNumber: room.currentRound });
}
function checkRoundComplete(roomCode) {
    var room = rooms[roomCode];
    var round = room.rounds[room.currentRound - 1];
    var done = room.pairs.every(function(pair) { return round.choices[pair.playerA] && round.choices[pair.playerB]; });
    if (done) resolveRound(roomCode);
}
function resolveRound(roomCode) {
    var room = rooms[roomCode];
    var round = room.rounds[room.currentRound - 1];
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
        return { id: p.id, name: p.name, score: room.scores[p.id], pairNumber: room.pairs.indexOf(pair) + 1, opponentName: opp ? opp.name : '?' };
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
    var rows = [];
    rows.push(['Rank','Player','Opponent','Pair','Score']);
    leaderboard.forEach(function(r, i) { rows.push([i + 1, r.name, r.opponentName, 'Pair ' + r.pairNumber, r.score]); });
    rows.push([]);
    rows.push(['--- All Pairs Round-by-Round ---']);
    rows.push(['Round','Pair','Player A','Choice A','Player B','Choice B','Pts A','Pts B']);
    allPairsHistory.forEach(function(r) {
        rows.push([r.round, r.pair, r.playerA, r.choiceA === 'collaborate' ? 'CoOperate' : 'Defect', r.playerB, r.choiceB === 'collaborate' ? 'CoOperate' : 'Defect', r.ptsA, r.ptsB]);
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
