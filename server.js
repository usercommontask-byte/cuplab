const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable CORS so your Netlify frontend can talk to this Render backend
const io = new Server(server, {
    cors: {
        origin: "*", // Allows any website to connect
        methods: ["GET", "POST"]
    }
});

// Serve the frontend files (Kept just in case, though Netlify handles the actual HTML now)
app.use(express.static('public'));

// Queues for each specific category from your frontend
const queues = {
    business: [],
    dating: [],
    friendship: [],
    gaming: [],
    language: [],
    casual: []
};

// Keep track of who is chatting with who
const activeChats = new Map(); 

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // 1. MATCHMAKING LOGIC
    socket.on('find_partner', (category) => {
        // Default to casual if an invalid category is sent
        const queueName = queues[category] ? category : 'casual';
        const queue = queues[queueName];

        // Check if someone is already waiting in this specific category
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
            // No one is waiting in this category, put this user in the queue
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
        console.log(`User disconnected: ${socket.id}`);
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
    console.log(`Server is running on port ${PORT}`);
});