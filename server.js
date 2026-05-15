const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

const queues = {
    casual: [],
    chess: []
};

const activeChats = new Map();

// Use Set so counts are always accurate (no double-counting)
const connectedUsers = new Set();
const chessUserSet = new Set();

function broadcastCounts() {
    io.emit('live_users', connectedUsers.size);
    io.emit('live_chess_users', chessUserSet.size);
}

io.on('connection', (socket) => {
    connectedUsers.add(socket.id);
    broadcastCounts();
    console.log(`User connected: ${socket.id} | Total: ${connectedUsers.size}`);

    // MATCHMAKING
    socket.on('find_partner', (category) => {
        const queueName = queues[category] ? category : 'casual';
        const queue = queues[queueName];

        // Remove from old chess set if switching modes
        if (socket.currentCategory === 'chess' && queueName !== 'chess') {
            chessUserSet.delete(socket.id);
        }

        socket.currentCategory = queueName;

        if (queueName === 'chess') {
            chessUserSet.add(socket.id);
        }

        broadcastCounts();

        // Remove from any old queue first (in case of reconnect)
        for (const [key, q] of Object.entries(queues)) {
            const idx = q.indexOf(socket);
            if (idx !== -1) q.splice(idx, 1);
        }

        if (queue.length > 0) {
            const partner = queue.shift();
            const roomName = `room_${partner.id}_${socket.id}`;

            partner.join(roomName);
            socket.join(roomName);

            activeChats.set(socket.id, { room: roomName, partnerId: partner.id, category: queueName });
            activeChats.set(partner.id, { room: roomName, partnerId: socket.id, category: queueName });

            io.to(socket.id).emit('matched', { role: 'initiator', color: 'white' });
            io.to(partner.id).emit('matched', { role: 'receiver', color: 'black' });
        } else {
            queue.push(socket);
            socket.waitingCategory = queueName;
        }
    });

    // TEXT CHAT
    socket.on('send_message', (text) => {
        const chat = activeChats.get(socket.id);
        if (chat) {
            socket.to(chat.room).emit('receive_message', text);
        }
    });

    // LEAVE / DISCONNECT
    socket.on('leave_chat', () => {
        handleLeave(socket, false);
    });

    socket.on('disconnect', () => {
        connectedUsers.delete(socket.id);
        chessUserSet.delete(socket.id);
        broadcastCounts();
        console.log(`User disconnected: ${socket.id} | Total: ${connectedUsers.size}`);
        handleLeave(socket, true);
    });

    // WEBRTC SIGNALING
    socket.on('webrtc_offer', (offer) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_offer', offer);
    });

    socket.on('webrtc_answer', (answer) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_answer', answer);
    });

    socket.on('webrtc_ice_candidate', (candidate) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_ice_candidate', candidate);
    });

    // GAME MOVES
    socket.on('chess_move', (move) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('chess_move', move);
    });

    // LOBBY SIGNALING
    socket.on('select_game', (gameName) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('game_selected', gameName);
    });

    socket.on('exit_game', () => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('return_to_lobby');
    });
});

function handleLeave(socket, isDisconnect) {
    // Remove from waiting queue
    for (const [key, q] of Object.entries(queues)) {
        const idx = q.indexOf(socket);
        if (idx !== -1) {
            q.splice(idx, 1);
            break;
        }
    }
    socket.waitingCategory = null;

    // If not a disconnect, clean up chess tracking
    if (!isDisconnect && socket.currentCategory === 'chess') {
        chessUserSet.delete(socket.id);
        broadcastCounts();
    }
    socket.currentCategory = null;

    // Notify partner
    const chat = activeChats.get(socket.id);
    if (chat) {
        socket.to(chat.room).emit('stranger_disconnected');
        socket.leave(chat.room);
        const partnerSocket = io.sockets.sockets.get(chat.partnerId);
        if (partnerSocket) {
            partnerSocket.leave(chat.room);
            activeChats.delete(chat.partnerId);
        }
        activeChats.delete(socket.id);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`CupLab server running on http://localhost:${PORT}`);
});
