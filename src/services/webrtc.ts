

import type { IceServerInfo, SignalingConnection } from "./signaling";

export class Peer{
    pc: RTCPeerConnection|null = null;
    dc: RTCDataChannel|null = null;
    signaling: SignalingConnection;
    peerId: string;
    sessionId: string;
    isConnected: boolean = false;
    isCaller: boolean = false;
    iceServers: IceServerInfo[] = [];
    private pendingCandidates: RTCIceCandidateInit[] = [];
    private lastConnectionState: RTCPeerConnectionState | null = null;

    constructor({signaling, peerId, sessionId
    }: {
        signaling: SignalingConnection;
        peerId: string;
        sessionId: string;
    }){
        this.signaling = signaling;
        this.peerId = peerId;
        this.sessionId = sessionId;
    }

    createPeerConnection(){
        if(this.pc) return;
        const config: RTCConfiguration = {
            iceServers: this.iceServers.map(server => ({
                urls: server.urls,
                username: server.username,
                credential: server.credential,
            })),
        };

        this.pc = new RTCPeerConnection(config);
        console.log('[WebRTC] create peer connection', {
            sessionId: this.sessionId,
            peerId: this.peerId,
            isCaller: this.isCaller,
            iceServers: this.iceServers,
        });
        this.pc.onicecandidate = (event) => {
            if(event.candidate){
                console.log('[WebRTC] local ICE candidate', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                });
                this.signaling.send({
                    type:'CANDIDATE',
                    sessionId: this.sessionId,
                    target: this.peerId,
                    candidate: event.candidate,
                })
            }
        }
        this.pc.onconnectionstatechange = () => {
            const state = this.pc?.connectionState;
            console.log('[WebRTC] connection state:', state, {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            if (!state || state === this.lastConnectionState) {
                return;
            }

            this.lastConnectionState = state;
            if (state === 'connected') {
                this.isConnected = true;
                console.log('[WebRTC] peer connected', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                    role: this.isCaller ? 'caller' : 'callee',
                });
                this.logSelectedCandidatePair();
            } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                this.isConnected = false;
                console.warn('[WebRTC] peer not connected', {
                    state,
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                    role: this.isCaller ? 'caller' : 'callee',
                });
            }
        }

        this.pc.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ICE connection state:', this.pc?.iceConnectionState, {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
        }

        this.pc.ondatachannel = (ev) => {
            this.setupDataChannel(ev.channel);
        }

        if (this.isCaller) {
            this.createDataChannel();
        }

        if(this.isCaller){
            this.createOffer();
        }

    }

    setupDataChannel(dc: RTCDataChannel){
        this.dc = dc;
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
            console.log('Data channel opened');
        }
        dc.onmessage = (event) => {
            console.log('Data channel message:', event.data);
        }

        dc.onclose = ()=>{
            console.log('Data channel closed');
        }

        dc.onerror = (error) => {
            console.error('Data channel error: ', error)
        }
    }

    createDataChannel(){
        if(!this.pc || this.dc) return;
        const dc = this.pc.createDataChannel('data', {ordered: true})
        this.setupDataChannel(dc)
        

    }

    private async createOffer(){
        if(!this.pc) return;
        try{
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            console.log('[WebRTC] sending offer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            this.signaling.send({
                type: "OFFER",
                sessionId: this.sessionId,
                target: this.peerId,
                sdp: offer.sdp!,
            })
        }catch(error){  
            console.error('Failed to create offer: ', error);
        }
    }

    async HandlerOffer(offer: RTCSessionDescriptionInit){
        if(!this.pc){
            this.createPeerConnection()
        }
        if(!this.pc) return;

        try{
            console.log('[WebRTC] received offer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            await this.pc.setRemoteDescription(offer);
            await this.flushPendingCandidates();
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            console.log('[WebRTC] sending answer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            this.signaling.send({
                type: "ANSWER",
                sessionId: this.sessionId,
                target: this.peerId,
                sdp: answer.sdp!,
            })
        }catch(error){
            console.error('Failed to handle offer:', error);
        }
        
    }

    async HandleAnswer(answer: RTCSessionDescriptionInit){
        if(!this.pc) return;

        try{
            console.log('[WebRTC] received answer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            await this.pc.setRemoteDescription(answer);
            await this.flushPendingCandidates();
        }catch(error){
            console.error('Failed to handle answer:', error);
        }
    }

    async HandleCandidate(candidate: RTCIceCandidateInit | RTCIceCandidate){
        if(!this.pc) return;

        try{
            const normalized = candidate instanceof RTCIceCandidate ? candidate.toJSON() : candidate;
            if (!normalized?.candidate) {
                return;
            }

            if (!this.pc.remoteDescription) {
                console.log('[WebRTC] queue remote ICE candidate until remote description', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                });
                this.pendingCandidates.push(normalized);
                return;
            }

            const iceCandidate = new RTCIceCandidate(normalized);
            console.log('[WebRTC] add remote ICE candidate', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            await this.pc.addIceCandidate(iceCandidate)
        }catch(error){
            console.error('Failed to add ICE candidate', error)
        }
        
            
    }

    destroy(){
        if (this.dc) {
            this.dc.onopen = null;
            this.dc.onmessage = null;
            this.dc.onclose = null;
            this.dc.onerror = null;
            this.dc.close();
            this.dc = null;
        }

        if (this.pc) {
            this.pc.onicecandidate = null;
            this.pc.onconnectionstatechange = null;
            this.pc.ondatachannel = null;
            this.pc.close();
            this.pc = null;
        }

        this.isConnected = false;
        this.lastConnectionState = null;
        this.pendingCandidates = [];
    }

    private async flushPendingCandidates(): Promise<void> {
        if (!this.pc || !this.pc.remoteDescription || this.pendingCandidates.length === 0) {
            return;
        }

        const candidates = this.pendingCandidates;
        this.pendingCandidates = [];

        for (const candidate of candidates) {
            try {
                console.log('[WebRTC] flush queued ICE candidate', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                });
                await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error('Failed to flush ICE candidate', error);
            }
        }
    }

    private async logSelectedCandidatePair(): Promise<void> {
        if (!this.pc) return;

        try {
            const stats = await this.pc.getStats();
            const transports: RTCStats[] = [];
            stats.forEach((entry) => {
                if (entry.type === 'transport') {
                    transports.push(entry);
                }
            });

            for (const transport of transports as RTCTransportStats[]) {
                const pairId = transport.selectedCandidatePairId;
                if (!pairId) continue;
                const pair = stats.get(pairId) as RTCStats | undefined;
                if (!pair || pair.type !== 'candidate-pair') continue;
                const local = stats.get((pair as RTCIceCandidatePairStats).localCandidateId) as RTCStats | undefined;
                const remote = stats.get((pair as RTCIceCandidatePairStats).remoteCandidateId) as RTCStats | undefined;

                const localCandidate = local as RTCStats & { protocol?: string; address?: string; port?: number };
                const remoteCandidate = remote as RTCStats & { protocol?: string; address?: string; port?: number };

                console.log('[WebRTC] selected ICE candidate pair', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                    local: local ? `${localCandidate.protocol ?? 'unknown'}:${localCandidate.address ?? 'unknown'}:${localCandidate.port ?? 'unknown'}` : 'unknown',
                    remote: remote ? `${remoteCandidate.protocol ?? 'unknown'}:${remoteCandidate.address ?? 'unknown'}:${remoteCandidate.port ?? 'unknown'}` : 'unknown',
                    currentRoundTripTime: (pair as RTCIceCandidatePairStats).currentRoundTripTime,
                });
                return;
            }

            console.log('[WebRTC] selected ICE candidate pair unavailable', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
        } catch (error) {
            console.warn('[WebRTC] failed to read ICE candidate pair stats', {
                sessionId: this.sessionId,
                peerId: this.peerId,
                error,
            });
        }
    }

}
