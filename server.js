const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend files from a 'public' folder
app.use(express.static('public'));

// We now have TWO queues: one for random chat, one for chess
const queues = {
    casual: [],
    chess: []
};

// Keep track of who is chatting with who
const activeChats = new Map(); 

// Track total live users and specific chess players
let totalUsers = 0;
let chessUsers = 0;

io.on('connection', (socket) => {
    // Increment total user count and broadcast
    totalUsers++;
    io.emit('live_users', totalUsers);
    io.emit('live_chess_users', chessUsers); // Send current chess count to new user
    
    console.log(`User connected: ${socket.id} | Total Live: ${totalUsers}`);

    // 1. MATCHMAKING LOGIC
    socket.on('find_partner', (category) => {
        // Fallback to casual if invalid, otherwise use requested category
        const queueName = queues[category] ? category : 'casual';
        const queue = queues[queueName];

        // Track what category the user is currently engaged in
        socket.currentCategory = queueName;
        
        // If they chose chess, increment chess user count and broadcast
        if (queueName === 'chess') {
            chessUsers++;
            io.emit('live_chess_users', chessUsers);
        }

        // Check if someone is already waiting in this specific queue
        if (queue.length > 0) {
            // Match found!
            const partner = queue.shift();
            const roomName = `room_${partner.id}_${socket.id}`;

            // Put both users in a private room
            partner.join(roomName);
            socket.join(roomName);

            // Record the active chat for both users
            activeChats.set(socket.id, { room: roomName, partnerId: partner.id, category: queueName });
            activeChats.set(partner.id, { room: roomName, partnerId: socket.id, category: queueName });

            // Tell both clients they are matched. 
            // We pass roles so the frontend knows who creates the WebRTC Video offer and who plays White in chess.
            io.to(socket.id).emit('matched', { role: 'initiator', color: 'white' });
            io.to(partner.id).emit('matched', { role: 'receiver', color: 'black' });
        } else {
            // No one is waiting, put this user in the queue
            queue.push(socket);
            socket.waitingCategory = queueName;
        }
    });

    // 2. TEXT CHAT LOGIC
    socket.on('send_message', (text) => {
        const chat = activeChats.get(socket.id);
        if (chat) {
            socket.to(chat.room).emit('receive_message', text);
        }
    });

    // 3. CHAT & GAME DISCONNECT LOGIC
    socket.on('leave_chat', () => {
        handleDisconnectOrLeave(socket);
    });

    socket.on('disconnect', () => {
        totalUsers--;
        io.emit('live_users', totalUsers);
        console.log(`User disconnected: ${socket.id} | Total Live: ${totalUsers}`);
        
        handleDisconnectOrLeave(socket);
    });

    // ==========================================
    // NEW: WEBRTC (VIDEO/AUDIO) & CHAT SIGNALING
    // ==========================================

    // Relay WebRTC Offer
    socket.on('webrtc_offer', (offer) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_offer', offer);
    });

    // Relay WebRTC Answer
    socket.on('webrtc_answer', (answer) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_answer', answer);
    });

    // Relay ICE Candidates for direct peer-to-peer connection
    socket.on('webrtc_ice_candidate', (candidate) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('webrtc_ice_candidate', candidate);
    });

    // Relay Chess Moves between players
    socket.on('chess_move', (move) => {
        const chat = activeChats.get(socket.id);
        if (chat) socket.to(chat.room).emit('chess_move', move);
    });
});

// Helper function to handle cleaning up when someone leaves or disconnects
function handleDisconnectOrLeave(socket) {
    // 1. Clean up chess user count if they were playing/waiting for chess
    if (socket.currentCategory === 'chess') {
        chessUsers--;
        if (chessUsers < 0) chessUsers = 0; // Failsafe
        io.emit('live_chess_users', chessUsers);
        socket.currentCategory = null;
    }

    // 2. Remove from queue if they were still waiting
    if (socket.waitingCategory && queues[socket.waitingCategory]) {
        const index = queues[socket.waitingCategory].indexOf(socket);
        if (index !== -1) {
            queues[socket.waitingCategory].splice(index, 1);
        }
        socket.waitingCategory = null;
    }

    // 3. Notify partner and destroy the active room
    const chat = activeChats.get(socket.id);
    if (chat) {
        socket.to(chat.room).emit('stranger_disconnected');
        
        // Remove both from the socket room
        socket.leave(chat.room);
        const partnerSocket = io.sockets.sockets.get(chat.partnerId);
        if (partnerSocket) {
            partnerSocket.leave(chat.room);
            activeChats.delete(chat.partnerId); // Clear partner's active chat state
        }

        activeChats.delete(socket.id); // Clear my active chat state
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
