import type {
    OfferMessage,
    SignalingConnection,
    WsServerMessage,
} from './signaling';
import { Peer } from './webrtc';

export class PeerManager {
    signaling: SignalingConnection;
    peersBySessionId: Map<string, Peer> = new Map();
    pendingCandidatesBySessionId: Map<string, RTCIceCandidateInit[]> = new Map();
    

    _onPeerCreated?: (peer: Peer) => void;
    _onPeerRemoved?: (peer: Peer) => void;
    _onError?: (error: unknown) => void;

    constructor(opts: {
        signaling: SignalingConnection;
        onPeerCreated?: (peer: Peer) => void;
        onPeerRemoved?: (peer: Peer) => void;
        onError?: (error: unknown) => void;
    }) {
        this.signaling = opts.signaling;
        this._onPeerCreated = opts.onPeerCreated;
        this._onPeerRemoved = opts.onPeerRemoved;
        this._onError = opts.onError;
    }

    startSession(peerId: string, sessionId: string = crypto.randomUUID()): Peer {
        const existing = this.peersBySessionId.get(sessionId);
        if (existing) {
            return existing;
        }

        console.log('[PeerManager] start session', { sessionId, peerId });

        const peer = new Peer({
            signaling: this.signaling,
            peerId,
            sessionId,
        });

        peer.isCaller = true;
        peer.iceServers = this.signaling.getIceServers();
        peer.createPeerConnection();

        this.peersBySessionId.set(sessionId, peer);
        this._onPeerCreated?.(peer);

        return peer;
    }

    async handleMessage(msg: WsServerMessage): Promise<void> {
        console.log('[PeerManager] handle message', msg.type);
        switch (msg.type) {
            case 'HELLO':
                this._refreshIceServers();
                return;

            case 'OFFER':
                await this._handleOffer(msg);
                return;

            case 'ANSWER':
                await this._handleAnswer(msg.sessionId, msg.sdp);
                return;

            case 'CANDIDATE':
                await this._handleCandidate(msg.sessionId, msg.candidate);
                return;

            case 'LEFT':
                this.removePeerByPeerId(msg.peerId);
                return;

            default:
                return;
        }
    }

    removePeerByPeerId(peerId: string): void {
        for (const [sessionId, peer] of this.peersBySessionId.entries()) {
            if (peer.peerId !== peerId) continue;
            peer.destroy();
            this.peersBySessionId.delete(sessionId);
            this.pendingCandidatesBySessionId.delete(sessionId);
            this._onPeerRemoved?.(peer);
        }
    }

    getConnectedPeers(): Peer[] {
        return Array.from(this.peersBySessionId.values()).filter((peer) => peer.dc?.readyState === 'open');
    }

    getConnectedPeerCount(): number {
        return this.getConnectedPeers().length;
    }

    sendFilesToConnectedPeers(files: FileList | File[]): { peers: number; files: number } {
        const list = Array.isArray(files) ? files : Array.from(files);
        if (list.length === 0) {
            return { peers: 0, files: 0 };
        }

        const peers = this.getConnectedPeers();
        for (const peer of peers) {
            peer.sendFiles(list);
        }

        return {
            peers: peers.length,
            files: list.length,
        };
    }

    destroy(): void {
        for (const peer of this.peersBySessionId.values()) {
            peer.destroy();
            this._onPeerRemoved?.(peer);
        }
        this.peersBySessionId.clear();
        this.pendingCandidatesBySessionId.clear();
    }

    private _refreshIceServers(): void {
        const iceServers = this.signaling.getIceServers();
        for (const peer of this.peersBySessionId.values()) {
            if (peer.pc) continue;
            peer.iceServers = iceServers;
        }
    }

    private async _handleOffer(msg: OfferMessage): Promise<void> {
        let peer = this.peersBySessionId.get(msg.sessionId);
        if (!peer) {
            peer = new Peer({
                signaling: this.signaling,
                peerId: msg.peer.id,
                sessionId: msg.sessionId,
            });
            peer.isCaller = false;
            peer.iceServers = this.signaling.getIceServers();
            this.peersBySessionId.set(msg.sessionId, peer);
            this._onPeerCreated?.(peer);
        }

        try {
            await peer.HandlerOffer({ type: 'offer', sdp: msg.sdp });
            await this._flushPendingCandidates(msg.sessionId, peer);
        } catch (error) {
            this._onError?.(error);
        }
    }

    private async _handleAnswer(sessionId: string, sdp: string): Promise<void> {
        const peer = this.peersBySessionId.get(sessionId);
        if (!peer) return;

        try {
            await peer.HandleAnswer({ type: 'answer', sdp });
        } catch (error) {
            this._onError?.(error);
        }
    }

    private async _handleCandidate(sessionId: string, candidate: RTCIceCandidateInit | null): Promise<void> {
        if (!candidate) return;

        const peer = this.peersBySessionId.get(sessionId);
        if (!peer) {
            const pending = this.pendingCandidatesBySessionId.get(sessionId) ?? [];
            pending.push(candidate);
            this.pendingCandidatesBySessionId.set(sessionId, pending);
            return;
        }

        try {
            await peer.HandleCandidate(candidate);
        } catch (error) {
            this._onError?.(error);
        }
    }

    private async _flushPendingCandidates(sessionId: string, peer: Peer): Promise<void> {
        const pending = this.pendingCandidatesBySessionId.get(sessionId);
        if (!pending || pending.length === 0) return;

        this.pendingCandidatesBySessionId.delete(sessionId);

        for (const candidate of pending) {
            await peer.HandleCandidate(candidate);
        }
    }
}
