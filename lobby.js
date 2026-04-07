"use strict";

// lobby.js — PeerJS room creation/joining, URL routing, lobby room + phase state machine
// Runs in both HOST and GUEST browsers.

(function initLobby() {
	const params = new URLSearchParams(window.location.search);
	const role   = params.get('role');   // 'host' | 'guest' | null
	const room   = params.get('room');   // 6-char code (guest only)

	if (role === 'host')       initHost();
	else if (role === 'guest') initGuest(room);
	else                       showLandingPage();

	// ─── Landing page ──────────────────────────────────────────────────────────
	function showLandingPage() {
		document.getElementById('mp-lobby').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');
		// mp-landing is visible by default (no hide class)

		document.getElementById('mp-btn-host').addEventListener('click', () => {
			window.location.href = '?role=host';
		});

		document.getElementById('mp-btn-guest').addEventListener('click', () => {
			showScreen('mp-join');
		});

		document.getElementById('mp-join-back').addEventListener('click', () => {
			showScreen('mp-landing');
		});

		document.getElementById('mp-btn-solo').addEventListener('click', () => {
			document.getElementById('mp-lobby').classList.add('hide');
			document.querySelector('main').classList.remove('hide');
			document.getElementById('toggle-music').classList.remove('hide');
		});

		document.getElementById('mp-join-btn').addEventListener('click', () => {
			const code = document.getElementById('mp-room-input').value.trim().toUpperCase();
			if (code.length === 6) window.location.href = '?role=guest&room=' + code;
			else alert('Enter a 6-character room code.');
		});

		// Allow Enter key in the code input
		document.getElementById('mp-room-input').addEventListener('keydown', e => {
			if (e.key === 'Enter') document.getElementById('mp-join-btn').click();
		});
	}

	// ─── Host flow ─────────────────────────────────────────────────────────────
	// Auto-boots peer on page load. No "Boot Server" button needed.
	function initHost() {
		document.getElementById('mp-lobby').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');

		// Show lobby room immediately — code will fill in when peer opens
		showScreen('mp-room');
		document.getElementById('mp-room-code-section').classList.remove('hide');
		document.getElementById('mp-room-status').textContent = 'Starting…';
		document.getElementById('mp-room-status').classList.add('mp-pulse');

		const code = generateRoomCode();
		startPeer(code, true);
	}

	// ─── Guest flow ────────────────────────────────────────────────────────────
	function initGuest(roomCode) {
		if (!roomCode) { showLandingPage(); return; }

		document.getElementById('mp-lobby').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');

		showScreen('mp-connecting');
		document.getElementById('mp-connect-code').textContent = roomCode.toUpperCase();
		startPeer(roomCode.toUpperCase(), false);
	}

	// ─── PeerJS init ────────────────────────────────────────────────────────────
	function startPeer(code, isHost) {
		// Host registers with room code as its peer ID.
		// Guest gets a random ID — it connects TO the host's code, not AS the code.
		const iceConfig = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } };
		const peer = isHost ? new Peer(code, iceConfig) : new Peer(iceConfig);

		peer.on('open', id => {
			if (isHost) {
				document.getElementById('mp-room-code').textContent = id.toUpperCase();
				setRoomStatus('Share the code above with your opponent', true);
			}
		});

		peer.on('error', e => {
			if (e.type === 'unavailable-id' && isHost) {
				// Room code collision — regenerate
				peer.destroy();
				startPeer(generateRoomCode(), true);
				return;
			}
			showError('Connection error: ' + e.message);
		});

		if (isHost) {
			peer.on('connection', conn => {
				conn.on('open', () => {
					multiplayer.dataChannel = conn;
					multiplayer.active = true;
					multiplayer.isGuest = false;
					multiplayer.hostLobbyReady = false;
					multiplayer.guestLobbyReady = false;

					// Route incoming guest messages
					conn.on('data', data => {
						const msg = JSON.parse(data);
						multiplayer.handleGuestAction(msg);
					});

					// Opponent slot becomes active
					document.getElementById('mp-slot-opp').classList.add('connected');
					setRoomStatus('Opponent joined! Press Ready when you\'re set.', false);

					// Wire the Ready button for host
					const readyBtn = document.getElementById('mp-ready-btn');
					readyBtn.classList.remove('hide');
					readyBtn.addEventListener('click', function onHostReady() {
						readyBtn.removeEventListener('click', onHostReady);
						readyBtn.disabled = true;
						readyBtn.textContent = 'Waiting for opponent…';
						multiplayer.hostLobbyReady = true;
						markReady('you');
						sendLobbyState();
						if (multiplayer.guestLobbyReady) advanceToDeckSelect();
					}, false);

					// Called when guest sends { action: 'lobbyReady' }
					multiplayer.onGuestLobbyReady = () => {
						markReady('opp');
						if (multiplayer.hostLobbyReady) advanceToDeckSelect();
						else setRoomStatus('Opponent is ready! Press Ready when you\'re set.', false);
					};
				});
				conn.on('error', e => showError('Connection lost: ' + e.message));
				conn.on('close', () => showError('Opponent disconnected.'));
			});
		} else {
			// Guest connects to host
			const conn = peer.connect(code, { reliable: true });
			conn.on('open', () => {
				multiplayer.dataChannel = conn;
				multiplayer.active = true;
				multiplayer.isGuest = true;

				// Route incoming messages — lobbyState + startDeckSelect handled here;
				// game states passed to renderGuestView
				conn.on('data', data => {
					const msg = JSON.parse(data);
					if (msg.type === 'lobbyState') {
						if (msg.hostReady) markReady('opp');
					} else if (msg.type === 'startDeckSelect') {
						showGuestDeckSelect();
					} else {
						renderGuestView(msg);
					}
				});

				// Show lobby room for guest (no code section)
				showScreen('mp-room');
				document.getElementById('mp-slot-opp').classList.add('connected');
				setRoomStatus('Connected! Press Ready when you\'re set.', false);

				const readyBtn = document.getElementById('mp-ready-btn');
				readyBtn.classList.remove('hide');
				readyBtn.addEventListener('click', function onGuestReady() {
					readyBtn.removeEventListener('click', onGuestReady);
					readyBtn.disabled = true;
					readyBtn.textContent = 'Waiting for opponent…';
					markReady('you');
					multiplayer.dataChannel.send(JSON.stringify({ action: 'lobbyReady' }));
				}, false);
			});
			conn.on('error', e => showError('Connection error: ' + e.message));
			conn.on('close', () => showError('Host disconnected. Please restart the game.'));
		}
	}

	// ─── Lobby room helpers ─────────────────────────────────────────────────────
	function setRoomStatus(text, pulse) {
		const el = document.getElementById('mp-room-status');
		el.textContent = text;
		el.classList.toggle('mp-pulse', pulse);
	}

	function markReady(who) {
		// who: 'you' | 'opp'
		const badge = document.getElementById('mp-ready-' + who);
		if (badge) { badge.textContent = 'READY'; badge.classList.add('is-ready'); }
	}

	function sendLobbyState() {
		if (!multiplayer.dataChannel || !multiplayer.dataChannel.open) return;
		multiplayer.dataChannel.send(JSON.stringify({
			type: 'lobbyState',
			hostReady: multiplayer.hostLobbyReady,
			guestReady: multiplayer.guestLobbyReady
		}));
	}

	function advanceToDeckSelect() {
		if (multiplayer.dataChannel && multiplayer.dataChannel.open) {
			multiplayer.dataChannel.send(JSON.stringify({ type: 'startDeckSelect' }));
		}
		showHostDeckSelect();
	}

	// ─── Deck selection ─────────────────────────────────────────────────────────
	function showHostDeckSelect() {
		document.getElementById('mp-lobby').classList.add('hide');
		document.getElementById('deck-customization').classList.remove('hide');
		if (typeof deckMaker !== 'undefined') {
			deckMaker.onReady = deck => {
				document.getElementById('deck-customization').classList.add('hide');
				multiplayer.handleHostDeck(deck);
			};
		}
	}

	function showGuestDeckSelect() {
		document.getElementById('mp-lobby').classList.add('hide');
		document.querySelector('main').classList.remove('hide');
		document.getElementById('deck-customization').classList.remove('hide');
		multiplayer.isGuest = true;

		// Replace the pass button's click handler — the default calls player_me.passRound()
		// which doesn't exist on the guest browser.
		const passBtn = document.getElementById('pass-button');
		const newPassBtn = passBtn.cloneNode(true);
		passBtn.parentNode.replaceChild(newPassBtn, passBtn);
		newPassBtn.addEventListener('click', () => {
			if (!multiplayer.dataChannel || !multiplayer.dataChannel.open) return;
			// During redraw: 'Pass' = done redrawing → send 'ready'
			// During playing: 'Pass' = pass the round → send 'pass'
			if (guestPrevState && guestPrevState.phase === 'redraw') {
				multiplayer.dataChannel.send(JSON.stringify({ action: 'ready' }));
			} else {
				guestPass();
			}
		}, false);

		if (typeof deckMaker !== 'undefined') {
			deckMaker.onReady = deck => {
				document.getElementById('deck-customization').classList.add('hide');
				// deck is already me_deck format — send directly
				multiplayer.dataChannel.send(JSON.stringify({ action: 'submitDeck', deck }));
				showGuestWaitingForRedraw();
			};
		}
	}

	function showGuestWaitingForRedraw() {
		// Show the waiting overlay; renderGuestPhase will hide it when phase='redraw' arrives
		document.getElementById('mp-lobby').classList.remove('hide');
		showScreen('mp-waiting');
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────
	// Hide all mp-screens and show only the named one
	function showScreen(id) {
		document.querySelectorAll('#mp-lobby .mp-screen').forEach(el => el.classList.add('hide'));
		document.getElementById(id).classList.remove('hide');
	}

	function generateRoomCode() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
		return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
	}

	function showError(msg) {
		document.getElementById('mp-error-msg').textContent = msg;
		showScreen('mp-error');
	}
})();
