// server.js (Final Complete Version)

const express = require('express');
// const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
// const selfsigned = require('selfsigned');
const path = require('path');

// Generate self-signed certificate for HTTPS
const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

const app = express();
// const server = https.createServer({ key: pems.private, cert: pems.cert }, app);
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (HTML, CSS, client.js)
app.use(express.static(__dirname));
// Serve the landing page as the main entry point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
});

// Data structure to store room and user info
const roomsData = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join-room', (data) => {
        const { roomName, username } = data;

        if (!roomsData[roomName]) {
            roomsData[roomName] = {
                host: socket.id,
                users: {},
                pendingUsers: {}
            };
            socket.join(roomName);
            roomsData[roomName].users[socket.id] = { role: 'host', muted: false, username: username };
            socket.emit('your-role', { role: 'host' });
            console.log(`User ${socket.id} (${username}) created and joined room ${roomName} as host.`);

            // No other users yet, so no 'other-users' to emit
            socket.emit('other-users', []);
            return; // Host joins directly
        }

        // Check if this is a reconnection from the same user
        const roomInfo = roomsData[roomName];
        let isReturningUser = false;
        let previousUserId = null;
        let wasHost = false;
        
        // Check if user with same username is already in the room
        for (const [userId, userInfo] of Object.entries(roomInfo.users)) {
            if (userInfo.username === username && userId !== socket.id) {
                isReturningUser = true;
                previousUserId = userId;
                wasHost = (roomInfo.host === userId);
                break;
            }
        }

        // If returning user, reconnect them instead of adding as pending
        if (isReturningUser && previousUserId) {
            // Remove the old connection
            delete roomInfo.users[previousUserId];
            
            // Preserve host role if they were the host
            const userRole = wasHost ? 'host' : 'participant';
            
            // Add the new connection
            roomInfo.users[socket.id] = { 
                role: userRole, 
                muted: false, 
                username: username 
            };
            
            // Update host if they were the host
            if (wasHost) {
                roomInfo.host = socket.id;
                console.log(`Host ${username} reconnected to room ${roomName} with new socket ID ${socket.id}`);
                // Notify all users that the host has reconnected
                socket.to(roomName).emit('host-reconnected', { username: username });
            }
            
            socket.join(roomName);
            socket.emit('your-role', { role: userRole });
            
            // Send the list of other active users
            const usersInRoom = roomInfo.users;
            const otherUsers = Object.keys(usersInRoom)
                .filter(id => id !== socket.id)
                .map(id => ({ id, muted: usersInRoom[id].muted, username: usersInRoom[id].username }));
            socket.emit('other-users', otherUsers);
            
            // Notify existing active users about the reconnected user
            socket.to(roomName).emit('user-joined', { id: socket.id, muted: false, username: username });
            
            console.log(`User ${username} reconnected to room ${roomName} with new socket ID ${socket.id} as ${userRole}`);
            return;
        }

        // For existing rooms, add user to pending list and notify host
        roomsData[roomName].pendingUsers[socket.id] = { username: username };
        console.log(`User ${socket.id} (${username}) is pending approval for room ${roomName}.`);

        // Notify the host about the pending user
        const hostSocketId = roomsData[roomName].host;
        if (io.sockets.sockets.has(hostSocketId)) {
            io.to(hostSocketId).emit('user-waiting-for-approval', { id: socket.id, username: username });
            console.log(`Notified host ${hostSocketId} about pending user ${username} (${socket.id}).`);
        }

        // Emit a confirmation to the joining user that they are waiting
        socket.emit('waiting-for-host-approval', { roomName: roomName });
    });

    // New: Host approves a user to join the room
    socket.on('approve-join', (payload) => {
        const { roomName, userId } = payload;
        const roomInfo = roomsData[roomName];

        if (roomInfo && roomInfo.host === socket.id && roomInfo.pendingUsers[userId]) {
            const approvedUser = roomInfo.pendingUsers[userId];
            delete roomInfo.pendingUsers[userId];

            // Add to active users
            roomInfo.users[userId] = { role: 'participant', muted: false, username: approvedUser.username };

            // Inform the approved user they can now join
            const targetSocket = io.sockets.sockets.get(userId);
            if (targetSocket) {
                targetSocket.join(roomName);
                targetSocket.emit('your-role', { role: 'participant' });
                console.log(`Host ${socket.id} approved user ${userId} (${approvedUser.username}) for room ${roomName}.`);

                // Send approved user the list of other active users
                const usersInRoom = roomInfo.users;
                const otherUsers = Object.keys(usersInRoom)
                    .filter(id => id !== userId)
                    .map(id => ({ id, muted: usersInRoom[id].muted, username: usersInRoom[id].username }));
                targetSocket.emit('other-users', otherUsers);

                // Notify existing active users about the new approved user
                socket.to(roomName).emit('user-joined', { id: userId, muted: false, username: approvedUser.username });
            }
        }
    });

    // New: Host rejects a user from joining the room
    socket.on('reject-join', (payload) => {
        const { roomName, userId } = payload;
        const roomInfo = roomsData[roomName];

        if (roomInfo && roomInfo.host === socket.id && roomInfo.pendingUsers[userId]) {
            const rejectedUser = roomInfo.pendingUsers[userId];
            delete roomInfo.pendingUsers[userId];

            const targetSocket = io.sockets.sockets.get(userId);
            if (targetSocket) {
                targetSocket.emit('join-rejected', { roomName: roomName });
                console.log(`Host ${socket.id} rejected user ${userId} (${rejectedUser.username}) from room ${roomName}.`);
                // Optionally disconnect the user if they were connected but not fully joined
                targetSocket.disconnect(true);
            }
        }
    });

    // إدارة الغرفة (كتم / طرد)
    socket.on('admin-kick-user', (payload) => {
        const { roomName, targetId } = payload;
        const roomInfo = roomsData[roomName];
        // Security Check: Only the host can kick
        if (roomInfo && roomInfo.host === socket.id) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.emit('you-are-kicked');
                targetSocket.disconnect(true);
                console.log(`Host ${socket.id} kicked user ${targetId} from room ${roomName}`);
            }
        }
    });

    socket.on('admin-toggle-mute', (payload) => {
        const { roomName, targetId } = payload;
        const roomInfo = roomsData[roomName];
        if (roomInfo && roomInfo.host === socket.id && roomInfo.users[targetId]) {
            const userToMute = roomInfo.users[targetId];
            userToMute.muted = !userToMute.muted;
            // Notify all clients in the room about the mute status change
            io.to(roomName).emit('user-mute-changed', { userId: targetId, isMuted: userToMute.muted });
            // Force the target user's client to mute/unmute their local stream
            io.to(targetId).emit('force-toggle-mute', { isMuted: userToMute.muted });
            console.log(`Host ${socket.id} toggled mute for user ${targetId} to ${userToMute.muted}`);
        }
    });

    // --- Standard WebRTC Signaling (with enhanced logging) ---
    socket.on('offer', (payload) => {
        console.log(`[SERVER] Relaying offer from ${socket.id} to ${payload.target}`);
        io.to(payload.target).emit('offer', { signal: payload.signal, callerId: payload.callerId });
    });
    socket.on('answer', (payload) => {
        console.log(`[SERVER] Relaying answer from ${socket.id} to ${payload.target}`);
        io.to(payload.target).emit('answer', { signal: payload.signal, callerId: payload.callerId });
    });
    socket.on('ice-candidate', (payload) => {
        console.log(`[SERVER] Relaying ICE candidate from ${socket.id} to ${payload.target}`);
        io.to(payload.target).emit('ice-candidate', { candidate: payload.candidate, senderId: socket.id });
    });
    socket.on('new-chat-message', (payload) => {
        const roomInfo = roomsData[payload.roomName];
        if (roomInfo && roomInfo.users[socket.id]) {
            const senderUsername = roomInfo.users[socket.id].username;
            // إرسال الرسالة مع اسم المستخدم بدلاً من المعرف
            socket.to(payload.roomName).emit('chat-message', { message: payload.message, senderUsername: senderUsername });
        }
    });
    socket.on('speaking', (data) => { socket.rooms.forEach(room => { if (room !== socket.id) { socket.to(room).emit('user-speaking', { userId: socket.id, speaking: data.speaking }); } }); });

    // --- Disconnect Logic with Room Cleanup and Host Reassignment ---
    //----12.التعامل مع قطع الاتصال
    socket.on('disconnecting', () => {
        console.log('User disconnecting:', socket.id);
        socket.rooms.forEach(roomName => {
            if (roomName !== socket.id) {
                socket.to(roomName).emit('user-left', socket.id);
                const roomInfo = roomsData[roomName];
                if (roomInfo && roomInfo.users[socket.id]) {
                    delete roomInfo.users[socket.id];
                    // If the host left, assign a new host
                    if (roomInfo.host === socket.id) {
                        const remainingUsers = Object.keys(roomInfo.users);
                        if (remainingUsers.length > 0) {
                            const newHostId = remainingUsers[0];
                            roomInfo.host = newHostId;
                            io.to(newHostId).emit('your-role', { role: 'host' });
                            console.log(`Room ${roomName} new host is ${newHostId}`);
                        } else {
                            // If no users left, delete the room data
                            delete roomsData[roomName];
                            console.log(`Room ${roomName} is now empty and deleted.`);
                        }
                    }
                }
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});
// 13. تشغيل السيرفر
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
