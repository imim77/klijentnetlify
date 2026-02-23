import { type AnswerMessage, type ClientInfo, SignalingConnection, type OfferMessage, type WsServerMessage } from './signaling';
import { Peer } from './webrtc';

type PeerStatus = 'connected' | 'not connected';

export class WebRTCController {
    connectionStatus = $state<'disconnected' | 'connecting' | 'connected'>('connecting');
    myId = $state('');
    myName = $state('');
    signaling: SignalingConnection;
    peers = $state<ClientInfo[]>([]);
    peerConnections = $state<Map<string, Peer>>(new Map());
    peerConnectionState = $state<Record<string, PeerStatus>>({});
    peerSessionById = $state<Record<string, string>>({});

    constructor(alias: string, deviceModel: string) {
        this.myName = alias;

        this.signaling = new SignalingConnection({
            info: {
                alias,
                deviceModel,
            },
            onOpen: () => {
                this.connectionStatus = 'connecting';
            },
            onMessage: (msg) => {
                this.handleSignalingMessage(msg);
            },
            onClose: () => {
                this.connectionStatus = 'disconnected';
                this.cleanupPeerConnections();
                this.peers = [];
                this.peerConnectionState = {};
                this.peerSessionById = {};
            },
            onError: (error) => {
                this.connectionStatus = 'disconnected';
                console.error('[Signaling] connection error', error);
            },
        });
    }

    handleSignalingMessage(msg: WsServerMessage): void {
        switch (msg.type) {
            case 'HELLO':
                this.myId = msg.client.id;
                if (msg.client.alias) {
                    this.myName = msg.client.alias;
                }
                this.peers = msg.peers.filter((peer) => peer.id !== this.myId);
                this.connectionStatus = 'connected';
                this.peers.forEach((peer) => {
                    this.connectPeer(peer.id);
                });
                return;
            case 'JOIN':
                if (msg.peer.id === this.myId) return;
                if (!this.peers.some((peer) => peer.id === msg.peer.id)) {
                    this.peers = [...this.peers, msg.peer];
                }
                this.connectPeer(msg.peer.id);
                return;
            case 'UPDATE':
                if (msg.peer.id === this.myId) {
                    if (msg.peer.alias) {
                        this.myName = msg.peer.alias;
                    }
                    return;
                }
                this.peers = this.peers.some((peer) => peer.id === msg.peer.id)
                    ? this.peers.map((peer) => (peer.id === msg.peer.id ? msg.peer : peer))
                    : [...this.peers, msg.peer];
                return;
            case 'LEFT': {
                const peer = this.peerConnections.get(msg.peerId);
                if (peer) {
                    peer.destroy();
                    this.peerConnections.delete(msg.peerId);
                }
                this.removePeerConnectionState(msg.peerId);
                this.removePeerSession(msg.peerId);
                this.peers = this.peers.filter((p) => p.id !== msg.peerId);
                return;
            }
            case 'OFFER':
                this.handleIncomingOffer(msg);
                return;
            case 'ANSWER':
                this.handleIncomingAnswer(msg);
                return;
            case 'CANDIDATE':
                this.handleIncomingCandidate(msg);
                return;
            case 'ERROR':
                console.error('[Signaling] server error', msg.code);
                return;
        }
    }

    connectToPeer(peerId: string): void {
        if (!peerId || peerId === this.myId) return;

        const existingPeer = this.peerConnections.get(peerId);
        if (existingPeer) {
            return;
        }

        const sessionId = this.newSessionId();
        const peer = this.constructPeer(peerId, sessionId);
        peer.isCaller = true;
        this.peerConnections.set(peerId, peer);
        this.setPeerSession(peerId, sessionId);
        this.setPeerConnectionState(peerId, 'not connected');
        peer.createPeerConnection();
    }

    sendFiles(peerId: string, files: FileList | File[]): void {
        const peer = this.peerConnections.get(peerId);
        if (!peer) return;
        peer.sendFiles(files);
    }

    connectionLabel(peerId: string){
        return this.peerConnectionState[peerId] ?? 'not connected';
    }

    isPeerConnected(peerId: string){
        return this.connectionLabel(peerId) === 'connected';
    }

    handleIncomingOffer(msg: OfferMessage){
        const peerId = msg.peer.id;
        const sessionId = msg.sessionId;
        const currentSession = this.peerSessionById[peerId];

        const existingPeer = this.peerConnections.get(peerId);
        if (existingPeer) {
            if (currentSession === sessionId) {
                void existingPeer.HandlerOffer({ type: 'offer', sdp: msg.sdp });
                return;
            }
            existingPeer.destroy();
        }

        const peer = this.constructPeer(peerId, sessionId);
        peer.isCaller = false;
        this.peerConnections.set(peerId, peer);
        this.setPeerSession(peerId, sessionId);
        this.setPeerConnectionState(peerId, 'not connected');
        void peer.HandlerOffer({ type: 'offer', sdp: msg.sdp });
    }

    handleIncomingAnswer(msg: AnswerMessage){
        if (this.peerSessionById[msg.peer.id] !== msg.sessionId) {
            console.warn('[WebRTC] ignoring answer for stale session', {
                peerId: msg.peer.id,
                expected: this.peerSessionById[msg.peer.id],
                received: msg.sessionId,
            });
            return;
        }
        const peer = this.peerConnections.get(msg.peer.id);
        if (!peer) return;
        void peer.HandleAnswer({ type: 'answer', sdp: msg.sdp });
    }

    handleIncomingCandidate(msg: Extract<WsServerMessage, { type: 'CANDIDATE' }>): void {
        if (this.peerSessionById[msg.peer.id] !== msg.sessionId) {
            console.warn('[WebRTC] ignoring candidate for stale session', {
                peerId: msg.peer.id,
                expected: this.peerSessionById[msg.peer.id],
                received: msg.sessionId,
            });
            return;
        }
        const peer = this.peerConnections.get(msg.peer.id);
        if (!peer) return;
        void peer.HandleCandidate(msg.candidate);
    }

    destroy(): void {
        this.cleanupPeerConnections();
        this.signaling.destroy();
        this.peers = [];
        this.peerConnectionState = {};
        this.peerSessionById = {};
        this.connectionStatus = 'disconnected';
    }

    private cleanupPeerConnections(): void {
        this.peerConnections.forEach((peer) => peer.destroy());
        this.peerConnections.clear();
    }

    private connectPeer(peerId: string): void {
        if (this.myId && peerId && peerId !== this.myId && this.myId < peerId) {
            this.connectToPeer(peerId);
        }
    }

    private constructPeer(peerId: string, sessionId: string): Peer {
        const peer = new Peer({
            signaling: this.signaling,
            peerId,
            sessionId,
            forceLoopbackHostCandidates: this.signaling.getIceMode() === 'none' && isLocalHost(),
            onConnectionStateChange: (state) => {
                const status: PeerStatus = state === 'connected' ? 'connected' : 'not connected';
                this.setPeerConnectionState(peerId, status);
            },
            onIceStateChange: (state, snapshot) => {
                if (state !== 'failed') return;
                console.warn('[WebRTC] ICE failed for peer', {
                    peerId,
                    sessionId,
                    snapshot,
                });
            },
        });
        peer.iceServers = this.signaling.getIceServers();
        return peer;
    }

    private setPeerConnectionState(peerId: string, status: PeerStatus){
        this.peerConnectionState = {
            ...this.peerConnectionState,
            [peerId]: status,
        };
    }

    private removePeerConnectionState(peerId: string): void {
        if (!(peerId in this.peerConnectionState)) return;
        const next = { ...this.peerConnectionState };
        delete next[peerId];
        this.peerConnectionState = next;
    }

    private setPeerSession(peerId: string, sessionId: string): void {
        this.peerSessionById = {
            ...this.peerSessionById,
            [peerId]: sessionId,
        };
    }

    private removePeerSession(peerId: string): void {
        if (!(peerId in this.peerSessionById)) return;
        const next = { ...this.peerSessionById };
        delete next[peerId];
        this.peerSessionById = next;
    }

    private newSessionId(): string {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

}

function isLocalHost(): boolean {
    const host = location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
}
