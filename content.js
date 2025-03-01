"use strict";

const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js"); 
document.documentElement.appendChild(script);


const Status = Object.freeze({
    FRIEND: "friend",
    BLOCKED: "blocked",
});

class Player {
    constructor(id, name, status, notes) {
        this.id = id;
        this.name = name;
        this.status = status;
        this.notes = notes;
    }

    isEmpty() {
        return !this.status && !this.notes;
    }

    toJson() {
        return {
            id: this.id,
            name: this.name,
            status: this.status,
            notes: this.notes,
        };
    }

    static fromJson(json) {
        return new Player(json.id, json.name, json.status, json.notes);
    }
}

class KnownList {
    static localStorageKey = "knownPlayers";

    static async create() {
        const data = await chrome.storage.local.get(KnownList.localStorageKey);
        const items = JSON.parse(data[KnownList.localStorageKey]);
        const players = items.map(item => Player.fromJson(item));
        return new KnownList(players);
    }

    constructor(knownPlayers) {
        this.playerMap = new Map(knownPlayers.map(p => [p.id, p]));
        this.updatePlayerCache();
    }

    getPlayer(id, name) {
        if (this.playerMap.has(id)) {
            return this.playerMap.get(id);
        }
        return new Player(id, name, null, null);
    }

    addPlayer(player) {
        this.playerMap.set(player.id, player);
        this.updatePlayerCache();
    }

    prunePlayer(id) {
        const player = this.playerMap.get(id);
        if (player?.isEmpty()) {
            this.playerMap.delete(id);
            this.updatePlayerCache();
        }
    }

    isFriend(id) {
        return this.friendIds.has(id);
    }

    isBlocked(id) {
        return this.blockedIds.has(id);
    }

    getNotes(id) {
        if (this.playerMap.has(id)) {
            return this.playerMap.get(id).notes ?? "";
        }
        return "";
    }

    toggleFriend(player) {
        if (player.status === Status.FRIEND) {
            player.status = null;
        } else {
            player.status = Status.FRIEND;
        }

        if (player.isEmpty()) {
            this.prunePlayer(player.id);
        } else {
            this.addPlayer(player);
        }
    }

    toggleBlocked(player) {
        if (player.status === Status.BLOCKED) {
            player.status = null;
        } else {
            player.status = Status.BLOCKED;
        }

        if (player.isEmpty()) {
            this.prunePlayer(player.id);
        } else {
            this.addPlayer(player);
        }
    }

    setNote(player, note) {
        player.notes = note;

        if (player.isEmpty()) {
            this.prunePlayer(player.id);
        } else {
            this.addPlayer(player);
        }
    }

    updatePlayerCache() {
        this.friendIds = new Set(this.playerMap.values().filter(p => p.status === Status.FRIEND).map(p => p.id));
        this.blockedIds = new Set(this.playerMap.values().filter(p => p.status === Status.BLOCKED).map(p => p.id));
        const playerList = [...this.playerMap.values().map(p => p.toJson())];
        chrome.storage.local.set({[KnownList.localStorageKey]: JSON.stringify(playerList)});
        console.log(playerList);
    }
}

class ModalObserver {
    constructor(baseElem, userModalCallback) {
        this.baseElem = baseElem;
        this.userModalObserver = this.createUserModalObserver(userModalCallback);
    }

    createUserModalObserver(callback) {
        const config = { childList: true };
        const observer = new MutationObserver((mutations) => {
            mutations
                .flatMap(mutation => Array.from(mutation.addedNodes))
                .filter(node => node.nodeType === Node.ELEMENT_NODE && node.matches("div.modal-backdrop.user"))
                .forEach(callback);
        });
        observer.observe(this.baseElem, config);
        return observer;
    }

    disconnect() {
        this.userModalObserver.disconnect();
    }
}

class LobbyObserver {
    constructor(lobbyElem, userUpdateCallback) {
        this.lobbyElem = lobbyElem;
        this.userUpdateObserver = this.createUserUpdateObserver(userUpdateCallback);
    }

    createUserUpdateObserver(callback) {
        const targetNode = this.lobbyElem.querySelector(".container");
        const config = { childList: true, subtree: true };
        const observer = new MutationObserver(callback);
        observer.observe(targetNode, config);
        return observer;
    }

    disconnect() {
        this.userUpdateObserver.disconnect();
    }
}

class LobbyFormatter {
    constructor(knownList) {
        this.knownList = knownList;
        this.idToUsernameMap = new Map();
    }

    updateIdMap(sessions) {
        sessions.forEach(session => {
            session.usersAll.forEach(user => {
                this.idToUsernameMap.set(user.id, user.username);
            });
        });
    }

    formatLobby() {
        document.querySelectorAll(".player").forEach(elem => this.processPlayer(elem), this);
        document.querySelectorAll(".storyteller > span").forEach(elem => this.processPlayer(elem), this);
        document.querySelectorAll(".spectators > span").forEach(elem => this.processPlayer(elem), this);
    }

    processPlayer(elem) {
        const id = this.getIdFromElem(elem);
        this.replaceIdWithName(elem, id);
        this.addLobbyHighlights(elem, id);
    }

    getIdFromElem(elem) {
        const idMatch = elem.textContent.match(/\d{4,}/);
        if (idMatch) {
            return idMatch[0];
        }
        return undefined;
    }

    replaceIdWithName(elem, id) {
        const name = this.idToUsernameMap.get(id);
        if (!name) {
            return;
        }
        elem.textContent = elem.textContent.replace(id, name);
        elem.dataset.id = id;
    }

    addLobbyHighlights(elem, id) {
        if (this.knownList.isFriend(id)) {
            elem.classList.add("friend");
            this.highlightLobby(elem, "friend");
        } else if (this.knownList.isBlocked(id)) {
            elem.classList.add("blocked");
            this.highlightLobby(elem, "blocked");
        }
    }

    highlightLobby(elem, status) {
        const detailsElem = elem.closest(".details");
        if (detailsElem) {
            detailsElem.classList.add(`has-${status}`);
            return;
        }

        const summaryElem = elem.closest(".summary");
        if (summaryElem) {
            summaryElem.nextSibling.classList.add(`has-${status}`);
        }
    }
}

class ModalHandler {
    constructor(knownList) {
        this.knownList = knownList;
    }

    async replaceModal(modalElem) {
        const userElem = modalElem.querySelector("#user");
        await this.finishLoading(userElem);

        const previewElem = userElem.querySelector(".preview");
        const profileElem = userElem.querySelector(".profile");

        const id = this.getId(profileElem);
        const name = this.getName(previewElem);
        let notes = this.knownList.getNotes(id);

        const notesElem = this.createNotesLine(profileElem.firstChild, notes);
        profileElem.insertBefore(notesElem, profileElem.firstChild.nextSibling);
        const [friendButton, blockedButton] = this.addStatusButtons(previewElem);
        this.updateStatusButtons(friendButton, blockedButton, id);

        friendButton.addEventListener("click", () => {
            const player = this.knownList.getPlayer(id, name);
            this.knownList.toggleFriend(player);
            this.updateStatusButtons(friendButton, blockedButton, id);
            document.querySelector(`[data-id="${id}"]`).classList.toggle("friend");
        });

        blockedButton.addEventListener("click", () => {
            const player = this.knownList.getPlayer(id, name);
            this.knownList.toggleBlocked(player);
            this.updateStatusButtons(friendButton, blockedButton, id);
            document.querySelector(`[data-id="${id}"]`).classList.toggle("blocked");
        });

        notesElem.addEventListener("click", () => {
            const newNoteText = prompt("Enter notes", notes);
            if (newNoteText !== null) {
                const player = this.knownList.getPlayer(id, name);
                this.knownList.setNote(player, newNoteText);
                notesElem.querySelector(".note-text").textContent = newNoteText;
                notes = newNoteText;
            }
        });
    }

    getId(profileElem) {
        const idLine = profileElem.firstChild;
        const id = idLine.querySelector("span").nextSibling.textContent;
        return id.trim();
    }

    getName(previewElem) {
        return previewElem.querySelector(".name").textContent;
    }

    createNotesLine(idElem, value) {
        const notesNode = idElem.cloneNode(true);
        notesNode.classList.add("toggle");
        const titleSpan = notesNode.querySelector("span");
        titleSpan.textContent = "Notes:";
        titleSpan.nextSibling.remove();
        const valueElem = document.createElement("span");
        valueElem.classList.add("note-text");
        valueElem.textContent = value;
        notesNode.appendChild(valueElem);
        return notesNode;
    }

    addStatusButtons(previewElem) {
        const friendButton = document.createElement("button");
        friendButton.classList.add("button", "status", "friend");
        const blockedButton = document.createElement("button");
        blockedButton.classList.add("button", "status", "blocked");
        const buttonHolder = document.createElement("div");
        buttonHolder.classList.add("status-button-container");
        buttonHolder.appendChild(friendButton);
        buttonHolder.appendChild(blockedButton);
        previewElem.insertBefore(buttonHolder, null);
        return [friendButton, blockedButton];
    }

    updateStatusButtons(friendButton, blockedButton, id) {
        if (this.knownList.isFriend(id)) {
            friendButton.textContent = "Remove friend";
            friendButton.classList.add("primary");
        } else {
            friendButton.textContent = "Add friend";
            friendButton.classList.remove("primary");
        }

        if (this.knownList.isBlocked(id)) {
            blockedButton.textContent = "Unblock user";
            blockedButton.classList.add("primary");
        } else {
            blockedButton.textContent = "Block user";
            blockedButton.classList.remove("primary");
        }
    }

    finishLoading(userElem) {
        if (!userElem.classList.contains("loading")) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const observer = new MutationObserver(() => {
                if (userElem.classList.contains("loading")) {
                    return;
                }

                observer.disconnect();
                resolve();
            });
            observer.observe(userElem, { attributeFilter: ["class"] });
        });
    }
}

class App {
    constructor(appElem, lobbyFormatter, modalHandler) {
        this.appElem = appElem;
        this.lobbyFormatter = lobbyFormatter;
        this.modalHandler = modalHandler;
        this.lobbyObserver = null;
        this.lobbyModalObserver = null;
        this.grimoireModalObserver = null;

        this.state = "starting";

        if (this.getLobbyElem()) {
            this.changeState("lobby");
        } else if (this.getGrimoireElem()) {
            this.changeState("grimoire");
        } else {
            throw Error("Unknown starting state");
        }

        this.appStateObserver = this.setupAppStateObserver();
    }

    setupAppStateObserver() {
        const handleAppMutation = () => {
            if (this.appElem.classList.contains("page-Lobby")) {
                this.changeState("lobby");
            } else if (this.appElem.classList.contains("page-Grimoire")) {
                this.changeState("grimoire");
            } else {
                throw Error("app missing classes: ", this.appElem.classList);
            }
        }
        const appStateObserver = new MutationObserver(handleAppMutation);
        appStateObserver.observe(this.appElem, { attributeFilter: ["class"] });
        return appStateObserver;
    }

    getLobbyElem() {
        return this.appElem.querySelector("#lobby");
    }

    getGrimoireElem() {
        return this.appElem.querySelector("#grimoire");
    }

    changeState(newState) {
        if (newState === this.state) return;
        console.log(`changing state from ${this.state} to ${newState}`);

        if (newState === "lobby") {
            this.grimoireModalObserver?.disconnect();
            this.fillLobby();
        } else if (newState === "grimoire") {
            this.lobbyObserver?.disconnect();
            this.lobbyModalObserver?.disconnect();
            this.fillGrimoire();
        } else {
            throw Error(`Unknown state ${newState}`);
        }

        this.state = newState;
    }

    fillLobby() {
        this.lobbyObserver = new LobbyObserver(this.getLobbyElem(),
            () => this.lobbyFormatter.formatLobby()
        );
        this.lobbyModalObserver = new ModalObserver(this.getLobbyElem(),
            (modal) => this.modalHandler.replaceModal(modal)
        );
    }

    fillGrimoire() {
        this.grimoireModalObserver = new ModalObserver(this.getGrimoireElem(),
            (modal) => this.modalHandler.replaceModal(modal)
        );
    }
}



(async () => {
    const appElem = document.getElementById("app");

    const knownList = await KnownList.create();
    const lobbyFormatter = new LobbyFormatter(knownList);
    const modalHandler = new ModalHandler(knownList);
    const app = new App(appElem, lobbyFormatter, modalHandler);


    window.addEventListener("message", (event) => {
        if (event.source !== window || event.data.type !== "USER_DATA") return;

        const sessions = event.data.data;
        lobbyFormatter.updateIdMap(sessions);
    });
})()


