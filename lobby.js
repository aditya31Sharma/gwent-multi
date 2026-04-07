"use strict";

// lobby.js — PeerJS room creation/joining, URL routing, phase state machine
// Runs in both HOST and GUEST browsers.

(function initLobby() {
	const params = new URLSearchParams(window.location.search);
	const role   = params.get('role');   // 'host' | 'guest' | null
	const room   = params.get('room');   // 6-char code (guest only)

	if (role === 'host')  initHost();
	else if (role === 'guest') initGuest(room);
	else showLandingPage();

	// ─── Landing page ─────────────────────────────────────────────────────────
	function showLandingPage() {
		// Hide game UI, show lobby overlay
		document.getElementById('mp-lobby').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');

		document.getElementById('mp-btn-host').addEventListener('click', () => {
			window.location.href = '?role=host';
		});
		document.getElementById('mp-btn-guest').addEventListener('click', () => {
			document.getElementById('mp-landing').classList.add('hide');
			document.getElementById('mp-join').classList.remove('hide');
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
	}

	// ─── Host flow ────────────────────────────────────────────────────────────
	function initHost() {
		document.getElementById('mp-lobby').classList.remove('hide');
		document.getElementById('mp-host').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');

		document.getElementById('mp-boot-btn').addEventListener('click', bootServer);
	}

	function bootServer() {
		const code = generateRoomCode();
		document.getElementById('mp-boot-btn').disabled = true;
		document.getElementById('mp-boot-btn').textContent = 'Starting...';
		startPeer(code, true);
	}

	function startPeer(code, isHost) {
		// PeerJS loaded via CDN script tag in index.html
		const peer = new Peer(code, {
			config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
		});

		peer.on('open', id => {
			if (isHost) {
				document.getElementById('mp-room-code').textContent = id.toUpperCase();
				document.getElementById('mp-host-waiting').classList.remove('hide');
				document.getElementById('mp-host-booting').classList.add('hide');
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
					// Listen for guest actions
					conn.on('data', data => {
						const msg = JSON.parse(data);
						multiplayer.handleGuestAction(msg);
					});
					// Advance to deck selection
					showHostDeckSelect();
				});
				conn.on('error', e => showError('Connection lost: ' + e.message));
				conn.on('close', () => showError('Guest disconnected.'));
			});
		} else {
			// Guest connects to host
			const conn = peer.connect(code, { reliable: true });
			conn.on('open', () => {
				multiplayer.dataChannel = conn;
				multiplayer.active = true;
				multiplayer.isGuest = true;
				// Listen for state updates from host
				conn.on('data', data => {
					const state = JSON.parse(data);
					renderGuestView(state);
				});
				showGuestDeckSelect();
			});
			conn.on('error', e => showError('Connection error: ' + e.message));
			conn.on('close', () => showError('Host disconnected. Please restart the game.'));
		}
	}

	// ─── Guest flow ──────────────────────────────────────────────────────────
	function initGuest(roomCode) {
		if (!roomCode) { showLandingPage(); return; }

		document.getElementById('mp-lobby').classList.remove('hide');
		document.getElementById('mp-connecting').classList.remove('hide');
		document.querySelector('main').classList.add('hide');
		document.getElementById('toggle-music').classList.add('hide');

		document.getElementById('mp-connect-code').textContent = roomCode.toUpperCase();
		startPeer(roomCode.toUpperCase(), false);
	}

	// ─── Deck selection ───────────────────────────────────────────────────────
	function showHostDeckSelect() {
		document.getElementById('mp-lobby').classList.add('hide');
		document.getElementById('deck-customization').classList.remove('hide');
		// Intercept the "Start game" button via DeckMaker's onReady callback
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
		// Override DeckMaker start button for guest
		if (typeof deckMaker !== 'undefined') {
			deckMaker.onReady = deck => {
				document.getElementById('deck-customization').classList.add('hide');
				multiplayer.dataChannel.send(JSON.stringify({ action: 'submitDeck', deck: serializeDeck(deck) }));
				showGuestWaitingForRedraw();
			};
		}
	}

	function showGuestWaitingForRedraw() {
		// Guest waits for host state sync which will trigger renderGuestView
		// with phase='redraw', at which point the guest sees their initial hand
		// and can send redrawCard messages
		document.getElementById('mp-waiting').classList.remove('hide');
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────
	function generateRoomCode() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
		return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
	}

	function serializeDeck(deckMakerInstance) {
		return {
			faction: deckMakerInstance.faction,
			leader: card_dict[deckMakerInstance.leader.index],
			cards: deckMakerInstance.deck.filter(x => x.count > 0)
		};
	}

	function showError(msg) {
		document.getElementById('mp-error-msg').textContent = msg;
		document.getElementById('mp-error').classList.remove('hide');
	}
})();
