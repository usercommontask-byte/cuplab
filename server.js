const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend files from a 'public' folder
app.use(express.static('public'));

// We only need one queue now for Random Chat
const queues = {
    casual: []
};

// Keep track of who is chatting with who
const activeChats = new Map(); 

// Track total live users
let totalUsers = 0;

io.on('connection', (socket) => {
    // Increment user count and broadcast to all connected clients
    totalUsers++;
    io.emit('live_users', totalUsers);
    
    console.log(`User connected: ${socket.id} | Total Live: ${totalUsers}`);

    // 1. MATCHMAKING LOGIC
    socket.on('find_partner', (category) => {
        // Force everyone into the casual (random) queue regardless of what the client sends
        const queueName = 'casual';
        const queue = queues[queueName];

        // Check if someone is already waiting
        if (queue.length > 0) {
            // Match found!
            const partner = queue.shift(); // Remove partner from queue
            const roomName = `room_${partner.id}_${socket.id}`;

            // Put both users in a private room
            partner.join(roomName);
            socket.join(roomName);

            // Record the active chat for both users
            activeChats.set(socket.id, { room: roomName, partnerId: partner.id });
            activeChats.set(partner.id, { room: roomName, partnerId: socket.id });

            // Tell both clients they are matched
            io.to(roomName).emit('matched');
        } else {
            // No one is waiting, put this user in the queue
            queue.push(socket);
            socket.waitingCategory = queueName; // Store category to clean up if they disconnect early
        }
    });

    // 2. CHAT MESSAGE LOGIC
    socket.on('send_message', (text) => {
        const chat = activeChats.get(socket.id);
        if (chat) {
            // Send the message only to the partner in the same room
            socket.to(chat.room).emit('receive_message', text);
        }
    });

    // 3. NEXT STRANGER / DISCONNECT LOGIC
    socket.on('leave_chat', () => {
        handleDisconnectOrLeave(socket);
    });

    socket.on('disconnect', () => {
        // Decrement user count and broadcast to all connected clients
        totalUsers--;
        io.emit('live_users', totalUsers);
        
        console.log(`User disconnected: ${socket.id} | Total Live: ${totalUsers}`);
        handleDisconnectOrLeave(socket);
    });
});

// Helper function to handle cleaning up when someone leaves or hits "Next"
function handleDisconnectOrLeave(socket) {
    // If they were waiting in a queue, remove them
    if (socket.waitingCategory && queues[socket.waitingCategory]) {
        const index = queues[socket.waitingCategory].indexOf(socket);
        if (index !== -1) {
            queues[socket.waitingCategory].splice(index, 1);
        }
        socket.waitingCategory = null;
    }

    // If they were in an active chat, notify the partner and clean up
    const chat = activeChats.get(socket.id);
    if (chat) {
        // Tell the partner the stranger left
        socket.to(chat.room).emit('stranger_disconnected');
        
        // Remove both from the room
        socket.leave(chat.room);
        const partnerSocket = io.sockets.sockets.get(chat.partnerId);
        if (partnerSocket) {
            partnerSocket.leave(chat.room);
        }

        // Clean up the map
        activeChats.delete(socket.id);
        activeChats.delete(chat.partnerId);
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
