"use strict";

// multiplayer.js — state sync layer for Gwent P2P multiplayer
// Runs on the HOST side only. Guest side uses renderGuestView().

const multiplayer = {
	active: false,         // true when a multiplayer game is in progress
	isGuest: false,        // true when this browser is the guest
	dataChannel: null,     // PeerJS DataConnection — set by lobby.js on open
	phase: 'lobby',        // lobby | deckSelect | redraw | playing | roundEnd | gameEnd
	prevState: null,       // last state sent, used for fly-in animation diff
	hostLobbyReady: false, // true when host clicked Ready in lobby room
	guestLobbyReady: false,// true when guest clicked Ready in lobby room
	onGuestLobbyReady: null, // callback set by lobby.js — fires when guest sends lobbyReady

	// Send current game state to guest. Called from Game.endTurn() and during
	// deck-select / redraw phases (which never call endTurn).
	async sync() {
		if (!this.dataChannel || !this.dataChannel.open) return;
		const state = game.getSerializableState();
		state.phase = this.phase;
		this.dataChannel.send(JSON.stringify(state));
	},

	// Route an incoming guest action message to the right handler.
	// Called from lobby.js's dataChannel.on('data') listener.
	// NOTE: only 'submitDeck' is handled here for game flow. lobbyReady is handled
	// for the pre-game lobby. All other game messages (redrawCard, ready, playCard,
	// pass, useLeader) are consumed by ControllerNetwork via waitForMessage().
	async handleGuestAction(msg) {
		if (msg.action === 'submitDeck') {
			this.guestDeck = msg.deck;
			// If host deck already set, advance to redraw
			if (this.hostDeck) await this.startRedraw();
		} else if (msg.action === 'lobbyReady') {
			this.guestLobbyReady = true;
			if (typeof this.onGuestLobbyReady === 'function') this.onGuestLobbyReady();
		}
	},

	// Called by DeckMaker's onReady callback on the host side
	async handleHostDeck(deck) {
		this.hostDeck = deck;
		this.phase = 'deckSelect';
		// Do NOT call sync() here — player_me/player_op don't exist yet
		// (DeckMaker.startNewGame returns early via onReady without creating players)
		if (this.guestDeck) await this.startRedraw();
	},

	async startRedraw() {
		this.phase = 'redraw';
		// Build player objects with chosen decks before starting
		const meDeck = this.hostDeck;
		const opDeck = this.guestDeck;
		player_me = new Player(0, 'Player 1', meDeck);
		player_op = new Player(1, 'Player 2', opDeck);
		// Replace AI controller with network controller
		player_op.controller = new ControllerNetwork(player_op);
		// Show the game board for the host (was hidden during lobby/deck phases)
		document.querySelector('main').classList.remove('hide');
		// Do NOT call sync() here — game.startGame() will draw cards first,
		// then ControllerNetwork.redraw() sends the first valid sync to guest
		game.startGame();
	},

	async startGame() {
		this.phase = 'playing';
		await this.sync();
	},

	// Called when phase transitions to roundEnd/gameEnd
	setPhase(phase) {
		this.phase = phase;
		this.sync();
	}
};

// ─── Guest-side rendering ─────────────────────────────────────────────────────
// renderGuestView(state) runs on the GUEST's browser. It receives a full state
// snapshot and re-renders the board from scratch.

let guestPrevState = null;

function renderGuestView(state) {
	renderGuestBoard(state);
	renderGuestHand(state);
	renderGuestStats(state);
	renderGuestWeather(state);
	renderGuestPhase(state);
	guestPrevState = state;
}

function serCardToElem(cardData) {
	// Mirrors Card.createCardElem() but from plain JSON data (no DOM element stored)
	const elem = document.createElement('div');
	elem.style.backgroundImage = smallURL(cardData.faction + '_' + cardData.filename);
	elem.classList.add('card', 'noclick');

	if (cardData.row === 'leader') return elem;

	// Power badge
	const power = document.createElement('div');
	let bg;
	if (cardData.hero) {
		bg = 'power_hero';
		elem.classList.add('hero');
	} else if (cardData.faction === 'weather') {
		bg = 'power_' + cardData.abilities[0];
	} else if (cardData.faction === 'special') {
		bg = 'power_' + cardData.abilities[0];
		elem.classList.add('special');
	} else {
		bg = 'power_normal';
	}
	power.style.backgroundImage = iconURL(bg);

	// Power number
	if (['close','ranged','siege','agile'].includes(cardData.row)) {
		const num = document.createElement('div');
		num.textContent = cardData.power;
		num.classList.add('center');
		// Color by buff/debuff
		if (cardData.power > cardData.basePower)      num.style.color = 'goldenrod';
		else if (cardData.power < cardData.basePower) num.style.color = 'red';
		power.appendChild(num);
	}
	elem.appendChild(power);

	// Row icon
	const rowIcon = document.createElement('div');
	if (['close','ranged','siege','agile'].includes(cardData.row))
		rowIcon.style.backgroundImage = iconURL('card_row_' + cardData.row);
	elem.appendChild(rowIcon);

	// Ability icon
	const abi = document.createElement('div');
	if (cardData.faction !== 'special' && cardData.faction !== 'weather' && cardData.abilities.length > 0) {
		let str = cardData.abilities[cardData.abilities.length - 1];
		if (str === 'cerys') str = 'muster';
		if (str.startsWith('avenger')) str = 'avenger';
		if (str === 'scorch_c' || str === 'scorch_r' || str === 'scorch_s') str = 'scorch';
		abi.style.backgroundImage = iconURL('card_ability_' + str);
	} else if (cardData.row === 'agile') {
		abi.style.backgroundImage = iconURL('card_ability_agile');
	}
	elem.appendChild(abi);

	elem.appendChild(document.createElement('div')); // animation overlay placeholder
	return elem;
}

function renderGuestBoard(state) {
	// board.row[0..5] mapped to DOM via Board constructor:
	// row[0..2] → field-op children[0..2], row[3..5] → field-me children[0..2]
	// state.board.rows are already in guest-DOM order (swapped by getSerializableState)
	const fieldOp = document.getElementById('field-op');
	const fieldMe = document.getElementById('field-me');

	state.board.rows.forEach((rowData, i) => {
		const fieldSection = i < 3 ? fieldOp : fieldMe;
		const rowElem = fieldSection.children[i % 3];
		const cardsContainer = rowElem.querySelector('.row-cards');
		const specialContainer = rowElem.querySelector('.row-special');

		// Detect newly added card for fly-in animation
		let newCardName = null;
		if (guestPrevState) {
			const prevRow = guestPrevState.board.rows[i];
			const prevNames = prevRow.cards.map(c => c.name);
			const newCard = rowData.cards.find(c => {
				// count occurrences: more in new state → newly played
				const prevCount = prevNames.filter(n => n === c.name).length;
				const newCount = rowData.cards.filter(n => n.name === c.name).length;
				return newCount > prevCount;
			});
			if (newCard) newCardName = newCard.name;
		}

		// Re-render cards
		cardsContainer.innerHTML = '';
		rowData.cards.forEach(cardData => {
			const cardElem = serCardToElem(cardData);
			if (cardData.name === newCardName) {
				cardElem.classList.add('card-fly-in');
				newCardName = null; // only animate first occurrence
			}
			cardsContainer.appendChild(cardElem);
		});

		// Special slot
		specialContainer.innerHTML = '';
		if (rowData.special) {
			specialContainer.appendChild(serCardToElem(rowData.special));
		}

		// Row score
		rowElem.querySelector('.row-score').textContent = rowData.score;

		// Weather overlay
		const weatherElem = rowElem.querySelector('.row-weather');
		weatherElem.className = 'row-weather';
		if (rowData.hasWeather) weatherElem.classList.add('weather-active');
	});
}

function renderGuestHand(state) {
	const handRow = document.getElementById('hand-row');
	handRow.innerHTML = '';
	state.myHand.forEach(cardData => {
		const cardElem = serCardToElem(cardData);
		cardElem.classList.remove('noclick');
		if (state.phase === 'redraw') {
			// During redraw: clicking a card swaps it with the deck (not plays it)
			cardElem.addEventListener('click', () => {
				if (multiplayer.dataChannel && multiplayer.dataChannel.open)
					multiplayer.dataChannel.send(JSON.stringify({ action: 'redrawCard', cardId: cardData.name }));
			}, false);
		} else {
			cardElem.addEventListener('click', () => guestSelectCard(cardData), false);
		}
		handRow.appendChild(cardElem);
	});
	document.getElementById('hand-count-me').textContent = state.myHand.length;
	document.getElementById('hand-count-op').textContent = state.opponentHandCount;
}

function renderGuestStats(state) {
	// Health gems
	['me', 'op'].forEach(tag => {
		const health = tag === 'me' ? state.myHealth : state.opponentHealth;
		[1, 2].forEach(gem => {
			const el = document.getElementById('gem' + gem + '-' + tag);
			if (gem <= health) el.classList.add('gem-on');
			else               el.classList.remove('gem-on');
		});
	});

	// Scores
	document.getElementById('score-total-me').children[0].textContent = state.myTotal;
	document.getElementById('score-total-op').children[0].textContent = state.opponentTotal;

	// Passed indicators
	document.getElementById('passed-me').classList.toggle('passed', state.myPassed);
	document.getElementById('passed-op').classList.toggle('passed', state.opponentPassed);

	// Current turn highlight
	document.getElementById('stats-me').classList.toggle('current-turn', state.currentTurn === 'guest');
	document.getElementById('stats-op').classList.toggle('current-turn', state.currentTurn === 'host');

	// Enable/disable pass button and hand cards
	// During redraw phase, ALWAYS enable (both players redraw simultaneously)
	const isMyTurn = state.currentTurn === 'guest';
	const isRedraw = state.phase === 'redraw';
	document.getElementById('pass-button').classList.toggle('noclick', !isMyTurn && !isRedraw);
	document.getElementById('pass-button').textContent = isRedraw ? 'Done' : 'Pass';
	document.getElementById('hand-row').classList.toggle('card-selectable', isMyTurn || isRedraw);

	// Leader card: render once on first state, then update availability
	if (state.myLeader) {
		const leaderBox = document.getElementById('leader-me');
		const leaderContainer = leaderBox.children[0];
		if (leaderContainer.children.length === 0) {
			// First render: populate leader card element and wire click
			leaderContainer.appendChild(serCardToElem(state.myLeader));
			leaderBox.addEventListener('click', () => {
				if (!leaderBox.classList.contains('noclick') && multiplayer.dataChannel && multiplayer.dataChannel.open)
					guestUseLeader();
			}, false);
		}
		// Toggle availability styling (mirrors Player.enableLeader / disableLeader)
		if (state.myLeaderAvailable) {
			leaderContainer.classList.remove('fade');
			leaderBox.children[1].classList.remove('hide');
		} else {
			leaderContainer.classList.add('fade');
			leaderBox.children[1].classList.add('hide');
		}
	}
}

function renderGuestWeather(state) {
	const weatherElem = document.getElementById('weather');
	weatherElem.innerHTML = '';
	state.weather.forEach(cardData => {
		weatherElem.appendChild(serCardToElem(cardData));
	});
}

function renderGuestPhase(state) {
	const banner = document.getElementById('redraw-banner');
	if (state.phase === 'redraw') {
		// First state arrival: dismiss the lobby waiting overlay, reveal game board
		document.getElementById('mp-lobby').classList.add('hide');
		document.getElementById('mp-waiting').classList.add('hide');
		document.getElementById('deck-customization').classList.add('hide');
		document.querySelector('main').classList.remove('hide');
		if (banner) banner.classList.remove('hide');
	} else {
		if (banner) banner.classList.add('hide');
		if (state.phase === 'roundEnd' || state.phase === 'gameEnd') {
			// Show end-of-round/game notification overlay
			const bar = document.getElementById('notification-bar');
			bar.children[0].textContent = state.phase === 'gameEnd' ? 'Game Over' : 'Round End';
			bar.classList.remove('hide');
			setTimeout(() => bar.classList.add('hide'), 2000);
		}
	}
}

// ─── Guest card interaction ───────────────────────────────────────────────────

let guestSelectedCard = null;

function guestSelectCard(cardData) {
	if (!multiplayer.dataChannel || !multiplayer.dataChannel.open) return;

	guestSelectedCard = cardData;

	// Agile cards need row selection before playing
	if (cardData.row === 'agile') {
		guestShowRowPicker(cardData);
		return;
	}
	guestPlayCard(cardData, null);
}

function guestShowRowPicker(cardData) {
	// Show a simple row-picker overlay
	const overlay = document.getElementById('mp-row-picker');
	if (!overlay) return guestPlayCard(cardData, 'close'); // fallback
	overlay.classList.remove('hide');
	overlay.dataset.card = cardData.name;
}

function guestPlayCard(cardData, row) {
	const msg = { action: 'playCard', cardId: cardData.name };
	if (row) msg.row = row;
	multiplayer.dataChannel.send(JSON.stringify(msg));
	guestSelectedCard = null;
}

function guestPass() {
	if (!multiplayer.dataChannel || !multiplayer.dataChannel.open) return;
	multiplayer.dataChannel.send(JSON.stringify({ action: 'pass' }));
}

function guestUseLeader() {
	if (!multiplayer.dataChannel || !multiplayer.dataChannel.open) return;
	multiplayer.dataChannel.send(JSON.stringify({ action: 'useLeader' }));
}

// Called by row-picker overlay buttons for agile cards
function guestPickRow(row) {
	document.getElementById('mp-row-picker').classList.add('hide');
	if (guestSelectedCard) guestPlayCard(guestSelectedCard, row);
}
