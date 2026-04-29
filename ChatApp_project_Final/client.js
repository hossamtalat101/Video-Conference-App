// client.js (Final Complete Version with Usernames)

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// --- DOM Element References ---
const localVideo = document.getElementById('localVideo');
const videoGrid = document.getElementById('video-grid');
const toggleCameraButton = document.getElementById('toggleCamera');
const toggleAudioButton = document.getElementById('toggleAudio');
const toggleScreenShareButton = document.getElementById('toggleScreenShare');
const endCallButton = document.getElementById('endCall');
const chatMessages = document.getElementById('chat-messages');
const chatInputField = document.getElementById('chat-input-field');
const sendMessageButton = document.getElementById('send-message-button');
const hostDashboard = document.getElementById('host-dashboard');
const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const toggleParticipantsBtn = document.getElementById('toggle-participants-btn');
const toggleChatBtn = document.getElementById('toggle-chat-btn');
const chatPanel = document.getElementById('chat-container');
const inviteLinkInput = document.getElementById('invite-link-input');
const copyInviteBtn = document.getElementById('copy-invite-btn');
const inviteContainer = document.getElementById('invite-container');
const inviteToggleBtn = document.getElementById('invite-toggle-btn');
const statusMessageDiv = document.getElementById('status-message');
const pendingUsersList = document.getElementById('pending-users-list');
// New: Disconnection message element
const disconnectMessageDiv = document.getElementById('disconnect-message');

// --- State Variables ---
const params = new URLSearchParams(window.location.search);
const roomName = params.get('room');
const username = params.get('username');

// New: Store room and username in localStorage for reconnection
if (roomName && username) {
    localStorage.setItem('lastRoom', roomName);
    localStorage.setItem('lastUsername', username);
}

let localStream;
let localCameraStream; // To store the camera stream when sharing screen
let isScreenSharing = false; // To track screen sharing state
const peerConnections = {}; // Stores { pc, muted, username, socketId, isLocal } for each user
let myRole = 'participant';
let isMutedByHost = false;
let myUsername = username || localStorage.getItem('lastUsername');
let mySocketId;

// Redirect to landing page if room name or username is missing from the URL
if (!roomName) {
    window.location.href = '/';
} else if (!username) {
    // If roomName exists but username is missing, redirect to landing page with room pre-filled
    window.location.href = `/landing.html?room=${roomName}`;
}

const stunServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// --- Main Logic: Get Media and Join Room ---
//--- الحصول على وسائط المتصفح والانضمام للغرفة

// New: Check if we should attempt reconnection
const shouldReconnect = !roomName && localStorage.getItem('lastRoom') && localStorage.getItem('lastUsername');

if (shouldReconnect) {
    // Redirect to room with stored credentials
    const lastRoom = localStorage.getItem('lastRoom');
    const lastUsername = localStorage.getItem('lastUsername');
    window.location.href = `/room.html?room=${lastRoom}&username=${encodeURIComponent(lastUsername)}`;
} else if (!roomName) {
    window.location.href = '/';
} else if (!username) {
    // If roomName exists but username is missing, redirect to landing page with room pre-filled
    window.location.href = `/landing.html?room=${roomName}`;
} else {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(stream => {
            console.log('Local media stream obtained:', stream);
            localStream = stream;
            localCameraStream = stream; // To store the camera stream when sharing screen
            localVideo.srcObject = stream;

            // Ensure local video plays
            localVideo.play().catch(e => console.log('Local video play failed:', e));

            // Send an object containing both roomName and username
            socket.emit('join-room', { roomName, username: myUsername });
            setupAudioAnalysis(stream);
            setupInviteLink();
        })
        .catch(error => {
            console.error('Error accessing media devices.', error);
            alert('تعذر الوصول إلى الكاميرا والميكروفون. يرجى التحقق من الأذونات والمحاولة مرة أخرى.');
        });
}

// --- Socket.IO Event Listeners ---

socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('My socket ID:', mySocketId);
    peerConnections[mySocketId] = { pc: null, muted: false, username: myUsername, socketId: mySocketId, isLocal: true };
    updateParticipantList();

    // New: Hide disconnect message when reconnected
    disconnectMessageDiv.style.display = 'none';
    statusMessageDiv.style.display = 'block';

    // New: Update localStorage with current socket ID
    localStorage.setItem('currentSocketId', socket.id);
});

socket.on('host-reconnected', (data) => {
    // Notify users that the host has reconnected
    appendMessage(`المضيف ${data.username} أعاد الاتصال`, 'system');
    console.log(`Host ${data.username} reconnected`);
});

socket.on('your-role', (data) => {
    myRole = data.role;
    if (myRole === 'host') {
        statusMessageDiv.textContent = '';
        if (isMutedByHost) {
            isMutedByHost = false;
            toggleAudioButton.disabled = false;
            toggleAudioButton.textContent = localStream.getAudioTracks()[0].enabled ? '🎤' : '🔇';
            alert('أنت الآن المضيف. يمكنك إلغاء كتم صوتك.');
        }
        // Ensure host controls are visible
        hostDashboard.style.display = 'flex';
    } else {
        statusMessageDiv.textContent = '';
        toggleAudioButton.disabled = false;
        toggleCameraButton.disabled = false;
        toggleScreenShareButton.disabled = false;
        sendMessageButton.disabled = false;
        chatInputField.disabled = false;
    }
    updateAdminControls();
    updateParticipantList();
    updatePendingUsersList();

    // Log role assignment for debugging
    console.log(`Assigned role: ${myRole} to user ${myUsername}`);
});

socket.on('waiting-for-host-approval', () => {
    statusMessageDiv.textContent = 'في انتظار موافقة المضيف...';
    // Optionally disable controls until approved
    toggleAudioButton.disabled = true;
    toggleCameraButton.disabled = true;
    toggleScreenShareButton.disabled = true;
    sendMessageButton.disabled = true;
    chatInputField.disabled = true;
});

socket.on('user-waiting-for-approval', (user) => {
    // Only host receives this
    if (myRole === 'host') {
        peerConnections[user.id] = { pc: null, muted: false, username: user.username, socketId: user.id, isLocal: false, status: 'pending' };
        updatePendingUsersList();
        alert(`المستخدم ${user.username} ينتظر الانضمام.`);
    }
});

socket.on('join-rejected', ({ roomName }) => {
    statusMessageDiv.textContent = 'تم رفض طلب الانضمام إلى الغرفة من قبل المضيف.';
    alert('تم رفض طلب الانضمام إلى الغرفة من قبل المضيف.');
    setTimeout(() => {
        window.location.href = '/';
    }, 3000);
});

socket.on('other-users', (otherUsers) => {
    console.log('=== OTHER USERS EVENT ===');
    console.log('Received other users:', otherUsers);
    // otherUsers is now an array of objects: [{ id, muted, username }]
    otherUsers.forEach(user => {
        console.log(`[client.js] other-users: Creating PC for ${user.username} (${user.id})`);
        const pc = createPeerConnection(user.id, true);
        peerConnections[user.id] = { pc, muted: user.muted, username: user.username, socketId: user.id, isLocal: false };
        console.log('Added peer connection for:', user.id, peerConnections[user.id]);
    });
    updateParticipantList();
    console.log('=== END OTHER USERS EVENT ===');
});

socket.on('user-joined', (user) => {
    console.log('=== USER JOINED EVENT ===');
    console.log('User joined:', user);
    console.log(`[client.js] user-joined: Creating PC for ${user.username} (${user.id})`);
    // Existing users must NOT be initiators — the new user will send offers via 'other-users'
    const pc = createPeerConnection(user.id, false);
    peerConnections[user.id] = { pc, muted: user.muted, username: user.username, socketId: user.id, isLocal: false };
    console.log('Added peer connection for new user:', user.id, peerConnections[user.id]);
    updateAdminControls();
    updateParticipantList();
    console.log('=== END USER JOINED EVENT ===');
});

socket.on('user-left', (userId) => {
    const userInfo = peerConnections[userId];
    const leftUsername = userInfo ? userInfo.username : 'مستخدم';

    if (userInfo) {
        userInfo.pc.close();
        delete peerConnections[userId];
    }
    const videoContainer = document.getElementById(`container-${userId}`);
    if (videoContainer) {
        videoContainer.remove();
    }
    updateAdminControls();
    updateParticipantList();
    appendMessage(`${leftUsername} غادر الغرفة.`, 'system');
    console.log(`User left: userId=${userId}, username=${leftUsername}`);
});

socket.on('user-mute-changed', ({ userId, isMuted }) => {
    if (peerConnections[userId]) {
        peerConnections[userId].muted = isMuted;
        updateAdminControlsForUser(userId);
        updateParticipantList();
    }
});

socket.on('force-toggle-mute', ({ isMuted }) => {
    localStream.getAudioTracks()[0].enabled = !isMuted;
    isMutedByHost = isMuted;
    if (isMuted) {
        toggleAudioButton.textContent = '🔇'; // Icon for muted by host
        toggleAudioButton.disabled = true;
        alert('لقد قام المضيف بكتم صوتك.');
    } else {
        toggleAudioButton.textContent = '🎤'; // Icon for unmuted
        toggleAudioButton.disabled = false;
        alert('لقد قام المضيف بإلغاء كتم صوتك. يمكنك التحدث الآن.');
    }
});

socket.on('you-are-kicked', () => {
    alert('لقد قام المضيف بإزالتك من الغرفة.');
    window.location.href = '/';
});

socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // New: Show disconnect message
    statusMessageDiv.style.display = 'none';
    disconnectMessageDiv.style.display = 'block';

    // Removed unused localStorage item
});

socket.on('offer', (payload) => {
    console.log('=== RECEIVED OFFER ===');
    console.log(`Received offer from ${payload.callerId}`);

    let pc = peerConnections[payload.callerId]?.pc;
    if (!pc) {
        console.log(`No existing PC for ${payload.callerId}, creating new one`);
        pc = createPeerConnection(payload.callerId, false);
        peerConnections[payload.callerId] = {
            pc,
            muted: false,
            username: peerConnections[payload.callerId]?.username || 'مستخدم غير معروف',
            socketId: payload.callerId,
            isLocal: false
        };
    }

    console.log('Setting remote description...');
    pc.setRemoteDescription(new RTCSessionDescription(payload.signal))
        .then(() => {
            console.log(`Set remote description for ${payload.callerId}`);
            console.log('Creating answer...');
            return pc.createAnswer();
        })
        .then(answer => {
            console.log(`Created answer for ${payload.callerId}`);
            return pc.setLocalDescription(answer);
        })
        .then(() => {
            console.log(`Sending answer to ${payload.callerId}`);
            socket.emit('answer', { target: payload.callerId, signal: pc.localDescription, callerId: socket.id });
        })
        .catch(e => {
            console.error('Error handling offer:', e);
            console.error('Stack trace:', e.stack);
        });

    console.log('=== END RECEIVED OFFER ===');
});

socket.on('answer', (payload) => {
    console.log(`Received answer from ${payload.callerId}`);
    const pc = peerConnections[payload.callerId]?.pc;
    if (pc) {
        pc.setRemoteDescription(new RTCSessionDescription(payload.signal))
            .then(() => {
                console.log(`Set remote description (answer) for ${payload.callerId}`);
            })
            .catch(e => console.error('Error setting remote description:', e));
    } else {
        console.warn(`No peer connection found for ${payload.callerId}`);
    }
});

socket.on('ice-candidate', (payload) => {
    console.log(`Received ICE candidate from ${payload.senderId}`);
    const pc = peerConnections[payload.senderId]?.pc;
    if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
            .then(() => {
                console.log(`Added ICE candidate for ${payload.senderId}`);
            })
            .catch(e => console.error('Error adding ICE candidate:', e));
    } else {
        console.warn(`No peer connection found for ICE candidate from ${payload.senderId}`);
    }
});

socket.on('chat-message', (payload) => {
    appendMessage(payload.message, 'other', payload.senderUsername);
});

socket.on('user-speaking', (data) => {
    const videoContainer = document.getElementById(`container-${data.userId}`);
    if (videoContainer) {
        videoContainer.classList.toggle('speaking', data.speaking);
    }
});

// --- WebRTC Core Logic ---
function createPeerConnection(targetUserId, isInitiator) {
    console.log(`[client.js] createPeerConnection: target=${targetUserId}, initiator=${isInitiator}`);
    const pc = new RTCPeerConnection(stunServers);
    // Add local stream tracks to peer connection
    if (localStream && localStream.getTracks().length > 0) {
        localStream.getTracks().forEach(track => {
            console.log(`Adding ${track.kind} track to PC for ${targetUserId} - Track state: ${track.readyState}`);
            pc.addTrack(track, localStream);
        });
        console.log(`Added ${localStream.getTracks().length} tracks to peer connection for ${targetUserId}`);
    } else {
        console.error(`No local stream or tracks available for ${targetUserId}`);
        console.log('Local stream:', localStream);
        if (localStream) {
            console.log('Local stream tracks:', localStream.getTracks());
        }
    }
    pc.onicecandidate = event => {
        if (event.candidate) {
            console.log(`Sending ICE candidate to ${targetUserId}`);
            socket.emit('ice-candidate', { target: targetUserId, candidate: event.candidate });
        }
    };

    pc.ontrack = event => {
        console.log(`[client.js] ontrack: kind=${event.track.kind}, streams=${event.streams.length}, target=${targetUserId}`);
        if (!event.streams || event.streams.length === 0) {
            console.warn(`ontrack received without streams for ${targetUserId}`);
            return;
        }
        const stream = event.streams[0];
        let videoContainer = document.getElementById(`container-${targetUserId}`);
        if (!videoContainer) {
            console.log(`[client.js] createVideoElement: Creating new video for ${targetUserId}`);
            createVideoElement(targetUserId, stream);
        } else {
            const video = videoContainer.querySelector('video');
            if (video) {
                // Only update if stream changed
                if (video.srcObject !== stream) {
                    video.srcObject = stream;
                }
                // Ensure video plays after setting srcObject
                video.play().catch(e => console.log('Video play failed:', e));
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state for ${targetUserId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            const videoContainer = document.getElementById(`container-${targetUserId}`);
            if (videoContainer) videoContainer.remove();
            if (peerConnections[targetUserId]) {
                peerConnections[targetUserId].pc.close();
                delete peerConnections[targetUserId];
            }
            updateParticipantList();
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state for ${targetUserId}: ${pc.connectionState}`);
    };

    if (isInitiator) {
        // Add a small delay to ensure the peer connection is properly set up
        setTimeout(() => {
            pc.createOffer()
                .then(offer => {
                    console.log(`Created offer for ${targetUserId}`);
                    return pc.setLocalDescription(offer);
                })
                .then(() => {
                    console.log(`Sending offer to ${targetUserId}`);
                    socket.emit('offer', { target: targetUserId, signal: pc.localDescription, callerId: socket.id });
                })
                .catch(e => console.error('Error creating offer:', e));
        }, 100);
    }
    return pc;
}

// --- UI Manipulation Functions ---
function createVideoElement(userId, stream) {
    if (userId === mySocketId) {
        console.warn(`[client.js] createVideoElement: Attempted to create remote video for local user (${userId}). Ignoring.`);
        return;
    }

    console.log(`[client.js] Creating video element for ${userId}`, stream);

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-box remote-video-box';
    videoContainer.id = `container-${userId}`;
    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // Remote videos should not be muted
    // Add event listeners to debug video loading
    video.addEventListener('loadedmetadata', () => {
        console.log(`Video metadata loaded for ${userId}`);
    });

    video.addEventListener('canplay', () => {
        console.log(`Video can play for ${userId}`);
        video.play().catch(e => console.log('Video play error:', e));
    });

    video.addEventListener('error', (e) => {
        console.error(`Video error for ${userId}:`, e);
    });

    const nameTag = document.createElement('h2');
    const userInfo = peerConnections[userId];
    nameTag.textContent = userInfo ? userInfo.username : `مستخدم: ${userId.substring(0, 6)}`;

    const adminControls = document.createElement('div');
    adminControls.className = 'admin-controls';

    videoContainer.append(nameTag, video, adminControls);
    videoGrid.appendChild(videoContainer);
    updateAdminControlsForUser(userId);

    // Force video to play after a short delay
    setTimeout(() => {
        if (video.srcObject && video.paused) {
            video.play().catch(e => console.log('Delayed video play failed:', e));
        }
    }, 100);
}

function updateAdminControls() {
    Object.keys(peerConnections).forEach(updateAdminControlsForUser);
}

function updateAdminControlsForUser(userId) {
    const videoContainer = document.getElementById(`container-${userId}`);
    if (!videoContainer) return;
    const adminControls = videoContainer.querySelector('.admin-controls');
    if (adminControls) {
        adminControls.innerHTML = '';
    }
}

function updateParticipantList() {
    participantList.innerHTML = '';
    let count = 0;
    // Filter out pending users from the main participant list
    const activeParticipants = Object.values(peerConnections).filter(p => p.status !== 'pending');

    // Sort participants: host first, then others alphabetically
    const sortedParticipants = activeParticipants.sort((a, b) => {
        if (myRole === 'host' && a.socketId === mySocketId) return -1;
        if (myRole === 'host' && b.socketId === mySocketId) return 1;
        return a.username.localeCompare(b.username);
    });

    sortedParticipants.forEach(p => {
        count++;
        const item = document.createElement('div');
        item.className = 'participant-item';
        const info = document.createElement('div');
        info.className = 'participant-info';
        if (p.socketId === mySocketId && myRole === 'host') {
            info.classList.add('is-host');
        }
        info.textContent = p.username + (p.socketId === mySocketId ? ' (أنت)' : '');
        const controls = document.createElement('div');
        controls.className = 'participant-controls';

        // Mute/Unmute button
        if (myRole === 'host' && p.socketId !== mySocketId) {
            const muteBtn = document.createElement('button');
            muteBtn.title = p.muted ? 'إلغاء كتم صوت المستخدم' : 'كتم صوت المستخدم';
            muteBtn.innerHTML = p.muted ? '🔊' : '🔇';
            muteBtn.onclick = () => socket.emit('admin-toggle-mute', { roomName, targetId: p.socketId });
            controls.appendChild(muteBtn);
        }

        // Kick button
        if (myRole === 'host' && p.socketId !== mySocketId) {
            const kickBtn = document.createElement('button');
            kickBtn.title = 'طرد المستخدم';
            kickBtn.innerHTML = '❌';
            kickBtn.onclick = () => {
                if (confirm(`هل أنت متأكد أنك تريد إزالة ${p.username}؟`)) {
                    socket.emit('admin-kick-user', { roomName, targetId: p.socketId });
                    console.log(`Attempting to kick user: ${p.username} (${p.socketId})`);
                    if (peerConnections[p.socketId]) {
                        peerConnections[p.socketId].pc?.close();
                        delete peerConnections[p.socketId];
                        const videoContainer = document.getElementById(`container-${p.socketId}`);
                        if (videoContainer) {
                            videoContainer.remove();
                            console.log(`Removed video container for ${p.username} (${p.socketId})`);
                        }
                        updateParticipantList();
                        updateAdminControls();
                    }
                }
            };
            controls.appendChild(kickBtn);
        }

        // Display mute status for all (not just host) in participant list
        if (p.muted) {
            const mutedStatus = document.createElement('span');
            mutedStatus.textContent = ' 🔇';
            info.appendChild(mutedStatus);
        }

        item.append(info, controls);
        participantList.appendChild(item);
    });
    participantCount.textContent = count;
}

function updatePendingUsersList() {
    pendingUsersList.innerHTML = '';
    if (myRole !== 'host') return;

    const pendingUsers = Object.values(peerConnections).filter(p => p.status === 'pending');

    if (pendingUsers.length === 0) {
        pendingUsersList.innerHTML = '<p>لا يوجد مستخدمون في انتظار الموافقة.</p>';
        return;
    }

    pendingUsers.forEach(user => {
        const item = document.createElement('div');
        item.className = 'pending-user-item';
        item.innerHTML = `
            <span>${user.username} (${user.socketId.substring(0, 6)})</span>
            <div>
                <button class="approve-btn" data-userid="${user.socketId}">✅ موافقة</button>
                <button class="reject-btn" data-userid="${user.socketId}">❌ رفض</button>
            </div>
        `;
        pendingUsersList.appendChild(item);
    });

    // Add event listeners for approve/reject buttons
    pendingUsersList.querySelectorAll('.approve-btn').forEach(button => {
        button.addEventListener('click', (event) => {
            const userId = event.target.dataset.userid;
            socket.emit('approve-join', { roomName, userId });
            // After approval, remove from pending list and add to active
            delete peerConnections[userId].status;
            updatePendingUsersList();
            updateParticipantList();
        });
    });

    pendingUsersList.querySelectorAll('.reject-btn').forEach(button => {
        button.addEventListener('click', (event) => {
            const userId = event.target.dataset.userid;
            socket.emit('reject-join', { roomName, userId });
            // After rejection, remove from peerConnections
            delete peerConnections[userId];
            updatePendingUsersList();
        });
    });
}

function setupInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.delete('username');
    inviteLinkInput.value = url.href;

    // Toggle invite container open/close
    inviteToggleBtn.addEventListener('click', () => {
        inviteContainer.classList.toggle('open');
        if (inviteContainer.classList.contains('open')) {
            // Automatically select and focus the input when opened
            inviteLinkInput.select();
            inviteLinkInput.setSelectionRange(0, 99999); // For mobile devices
            // No need to copy automatically, user will click the copy button
        }
    });

    copyInviteBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
            copyInviteBtn.textContent = '✅';
            copyInviteBtn.classList.add('copied');
            setTimeout(() => {
                copyInviteBtn.textContent = '📋';
                copyInviteBtn.classList.remove('copied');
            }, 2000);
        }).catch(err => console.error('Failed to copy link:', err));
    });
}

function sendMessage() {
    const message = chatInputField.value;
    if (message.trim() === '') return;
    appendMessage(message, 'self', myUsername);
    socket.emit('new-chat-message', { message, roomName });
    chatInputField.value = '';
}

function appendMessage(message, type, senderUsername) {
    const messageElement = document.createElement('div');
    messageElement.className = `chat-message ${type}`;
    let displayName = type === 'self' ? 'أنت' : senderUsername;
    if (type === 'system') {
        displayName = ''; // System messages don't need a display name
        messageElement.classList.add('system-message');
    }
    messageElement.innerHTML = `<strong>${displayName ? displayName + ':' : ''}</strong> ${message}`;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Mobile panel toggle functionality
function setupMobilePanelToggles() {
    if (toggleParticipantsBtn && hostDashboard) {
        toggleParticipantsBtn.addEventListener('click', () => {
            hostDashboard.classList.toggle('open');
            chatPanel.classList.remove('open');
        });
    }
    if (toggleChatBtn && chatPanel) {
        toggleChatBtn.addEventListener('click', () => {
            chatPanel.classList.toggle('open');
            hostDashboard.classList.remove('open');
        });
    }
}

// Call setup function after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    setupMobilePanelToggles();
});

// --- Event Listeners for Controls ---
sendMessageButton.addEventListener('click', sendMessage);
chatInputField.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

toggleAudioButton.addEventListener('click', () => {
    if (isMutedByHost) {
        alert('لا يمكنك إلغاء كتم صوتك لأن المضيف كتم صوتك.');
        return;
    }
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    toggleAudioButton.textContent = audioTrack.enabled ? '🎤' : '🔇';
});

toggleCameraButton.addEventListener('click', () => {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    toggleCameraButton.textContent = videoTrack.enabled ? '📸' : '📷';
});

toggleScreenShareButton.addEventListener('click', () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});

async function startScreenShare() {
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

        // Listen for the 'inactive' event on the screen track (e.g., user clicks the browser's stop sharing button)
        screenStream.getVideoTracks()[0].addEventListener('ended', () => {
            stopScreenShare();
        });

        localStream = screenStream;
        localVideo.srcObject = screenStream;

        // Replace the track for all peer connections
        const videoTrack = screenStream.getVideoTracks()[0];
        for (const peerId in peerConnections) {
            // Ensure we don't try to access .pc on the local user placeholder
            if (peerConnections[peerId] && peerConnections[peerId].pc) {
                const pc = peerConnections[peerId].pc;
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            }
        }

        isScreenSharing = true;
        toggleScreenShareButton.textContent = '⏹️';
    } catch (e) {
        console.error('Screen sharing failed:', e);
        // Handle cases where the user cancels the screen share prompt
        stopScreenShare(); // Revert to camera if sharing fails to start
    }
}

function stopScreenShare() {
    // Stop all tracks of the screen sharing stream to release resources
    if (isScreenSharing && localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    // Restore the camera stream
    localStream = localCameraStream;
    localVideo.srcObject = localCameraStream;

    // Replace the track back to the camera for all peer connections
    const videoTrack = localCameraStream.getVideoTracks()[0];
    for (const peerId in peerConnections) {
        if (peerConnections[peerId] && peerConnections[peerId].pc) {
            const pc = peerConnections[peerId].pc;
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        }
    }

    isScreenSharing = false;
    toggleScreenShareButton.textContent = '🖥️';
}

endCallButton.addEventListener('click', () => {
    if (confirm('هل أنت متأكد أنك تريد مغادرة الغرفة؟')) {
        window.location.href = '/';
    }
});

// --- Audio Analysis for Speaker Detection ---
function setupAudioAnalysis(stream) {
    if (!stream.getAudioTracks().length) return;
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    let speaking = false;
    const speakingThreshold = 20;
    setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const wasSpeaking = speaking;
        speaking = avg > speakingThreshold;
        if (speaking !== wasSpeaking) {
            socket.emit('speaking', { speaking });
        }
    }, 200);
}
