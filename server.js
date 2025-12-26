const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

const PORT = 3000;

// Store game data in memory
const games = {};

app.use(express.static(__dirname));
app.use(express.json());

// Serve host page
app.get('/host', (req, res) => {
    const hostPath = path.join(__dirname, 'quiz-host.html');
    if (fs.existsSync(hostPath)) {
        res.sendFile(hostPath);
    } else {
        res.status(404).send('quiz-host.html not found. Please make sure the file exists in: ' + __dirname);
    }
});

// Serve player page
app.get('/play', (req, res) => {
    const playerPath = path.join(__dirname, 'quiz-player.html');
    if (fs.existsSync(playerPath)) {
        res.sendFile(playerPath);
    } else {
        res.status(404).send('quiz-player.html not found. Please make sure the file exists in: ' + __dirname);
    }
});

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create new game
    socket.on('create-game', (data) => {
        const gameId = data.gameId;
        games[gameId] = {
            players: [],
            currentQuestion: 0,
            state: 'waiting',
            answers: {}
        };
        socket.join(gameId);
        socket.emit('game-created', { gameId });
        console.log('Game created:', gameId);
    });

    // Player joins game
    socket.on('join-game', (data) => {
        const { gameId, playerName } = data;
        
        if (!games[gameId]) {
            socket.emit('error', { message: 'اللعبة غير موجودة' });
            return;
        }

        const playerId = socket.id;
        const player = {
            id: playerId,
            name: playerName,
            totalScore: 0,
            answers: []
        };

        games[gameId].players.push(player);
        socket.join(gameId);

        // Notify host
        io.to(gameId).emit('player-joined', {
            players: games[gameId].players
        });

        socket.emit('joined-successfully', { playerId, gameId });
        console.log(`Player ${playerName} joined game ${gameId}`);
    });

    // Host starts game
    socket.on('start-game', (data) => {
        const { gameId } = data;
        
        if (!games[gameId]) return;

        games[gameId].state = 'playing';
        games[gameId].currentQuestion = 0;
        games[gameId].answers = {};

        io.to(gameId).emit('game-started', {
            questionIndex: 0
        });
        console.log('Game started:', gameId);
    });

    // Host starts new question
    socket.on('start-question', (data) => {
        const { gameId, questionIndex, question, startTime } = data;
        
        if (!games[gameId]) return;

        games[gameId].currentQuestion = questionIndex;
        games[gameId].answers = {};

        io.to(gameId).emit('new-question', {
            questionIndex,
            question,
            startTime
        });
        console.log(`Question ${questionIndex} started for game ${gameId}`);
    });

    // Player submits answer
    socket.on('submit-answer', (data) => {
        const { gameId, playerId, questionIndex, answer, time } = data;
        
        if (!games[gameId]) return;

        if (!games[gameId].answers[questionIndex]) {
            games[gameId].answers[questionIndex] = {};
        }

        games[gameId].answers[questionIndex][playerId] = {
            answer,
            time
        };

        // Find player and update their answers
        const player = games[gameId].players.find(p => p.id === playerId);
        if (player) {
            if (!player.answers[questionIndex]) {
                player.answers[questionIndex] = {
                    answer,
                    time
                };
            }
        }

        // Notify host
        io.to(gameId).emit('answer-submitted', {
            playerId,
            questionIndex,
            answer,
            time,
            totalAnswers: Object.keys(games[gameId].answers[questionIndex]).length,
            totalPlayers: games[gameId].players.length
        });

        console.log(`Answer submitted by ${playerId} for question ${questionIndex}`);
    });

    // Host ends round and calculates scores
    socket.on('end-round', (data) => {
        const { gameId, questionIndex, correctAnswer } = data;
        
        if (!games[gameId]) return;

        const answers = games[gameId].answers[questionIndex] || {};
        const players = games[gameId].players;

        // Calculate scores
        const playersWithAnswers = players.filter(p => answers[p.id]);
        
        const sorted = [...playersWithAnswers].sort((a, b) => {
            const answerA = answers[a.id];
            const answerB = answers[b.id];
            const diffA = Math.abs(answerA.answer - correctAnswer);
            const diffB = Math.abs(answerB.answer - correctAnswer);
            
            if (diffA === diffB) {
                return answerA.time - answerB.time;
            }
            return diffA - diffB;
        });

        const scoreValues = [1000, 700, 500, 300];
        
        const results = {};
        playersWithAnswers.forEach(player => {
            const rank = sorted.findIndex(p => p.id === player.id);
            const score = rank < scoreValues.length ? scoreValues[rank] : 300;
            
            player.answers[questionIndex] = {
                ...answers[player.id],
                score,
                rank: rank + 1
            };
            player.totalScore += score;

            results[player.id] = {
                answer: answers[player.id].answer,
                time: answers[player.id].time,
                score,
                rank: rank + 1,
                totalScore: player.totalScore
            };
        });

        // Mark players who didn't answer
        players.filter(p => !answers[p.id]).forEach(player => {
            player.answers[questionIndex] = {
                answer: null,
                time: null,
                score: 0,
                rank: null
            };
            results[player.id] = {
                answer: null,
                time: null,
                score: 0,
                rank: null,
                totalScore: player.totalScore
            };
        });

        io.to(gameId).emit('round-results', {
            questionIndex,
            correctAnswer,
            results,
            players: games[gameId].players
        });

        console.log(`Round ${questionIndex} ended for game ${gameId}`);
    });

    // Host shows final results
    socket.on('show-final-results', (data) => {
        const { gameId } = data;
        
        if (!games[gameId]) return;

        games[gameId].state = 'ended';

        const sortedPlayers = [...games[gameId].players].sort((a, b) => b.totalScore - a.totalScore);

        io.to(gameId).emit('final-results', {
            players: sortedPlayers
        });

        console.log(`Final results shown for game ${gameId}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove player from all games
        Object.keys(games).forEach(gameId => {
            const game = games[gameId];
            const playerIndex = game.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const playerName = game.players[playerIndex].name;
                // Don't remove player, just mark as disconnected
                // This way their data persists
                console.log(`Player ${playerName} disconnected from game ${gameId}, but data preserved`);
                
                // Notify others
                io.to(gameId).emit('player-disconnected', {
                    playerId: socket.id,
                    playerName
                });
            }
        });
    });

    // Player reconnects
    socket.on('reconnect-player', (data) => {
        const { gameId, playerName } = data;
        
        if (!games[gameId]) {
            socket.emit('error', { message: 'اللعبة غير موجودة' });
            return;
        }

        const player = games[gameId].players.find(p => p.name === playerName);
        
        if (player) {
            // Update socket ID
            const oldId = player.id;
            player.id = socket.id;
            
            socket.join(gameId);
            
            socket.emit('reconnected-successfully', {
                playerId: socket.id,
                gameId,
                player: player,
                gameState: {
                    state: games[gameId].state,
                    currentQuestion: games[gameId].currentQuestion
                }
            });

            io.to(gameId).emit('player-reconnected', {
                playerId: socket.id,
                playerName
            });

            console.log(`Player ${playerName} reconnected to game ${gameId}`);
        } else {
            socket.emit('error', { message: 'اللاعب غير موجود في هذه اللعبة' });
        }
    });
});

http.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Host page: http://localhost:${PORT}/host`);
    console.log(`👥 Player page: http://localhost:${PORT}/play`);
    console.log(`\n💡 للوصول من الهاتف: استخدم IP Address جهازك بدلاً من localhost`);
});