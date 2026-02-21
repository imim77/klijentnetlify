import { FileChunker, FileDigester, type ReceivedFile } from './files';
import type { IceServerInfo, SignalingConnection } from './signaling';

type TransferMessage =
    | { type: 'header'; name: string; mime?: string; size: number }
    | { type: 'partition'; offset: number }
    | { type: 'partition-received'; offset: number }
    | { type: 'progress'; progress: number }
    | { type: 'transfer-complete' };

export class Peer {
    pc: RTCPeerConnection | null = null;
    dc: RTCDataChannel | null = null;
    signaling: SignalingConnection;
    peerId: string;
    sessionId: string;
    isConnected = false;
    isCaller = false;
    iceServers: IceServerInfo[] = [];

    private pendingCandidates: RTCIceCandidateInit[] = [];
    private lastConnectionState: RTCPeerConnectionState | null = null;
    private readonly fileTransfer: FileTransfer;

    constructor({ signaling, peerId, sessionId }: { signaling: SignalingConnection; peerId: string; sessionId: string }) {
        this.signaling = signaling;
        this.peerId = peerId;
        this.sessionId = sessionId;

        this.fileTransfer = new FileTransfer({
            peerId,
            sendRaw: (payload) => this.sendData(payload),
            onFileReceived: (file) => this.handleReceivedFile(file),
            onProgress: (progress) => {
                console.log('[WebRTC] transfer progress', { peerId: this.peerId, sessionId: this.sessionId, progress });
            },
            onTransferCompleted: () => {
                console.log('[WebRTC] transfer completed', { peerId: this.peerId, sessionId: this.sessionId });
            },
        });
    }

    sendFiles(files: FileList | File[]): void {
        this.fileTransfer.sendFiles(files);
    }

    createPeerConnection(): void {
        if (this.pc) return;

        const config: RTCConfiguration = {
            iceServers: this.iceServers.map((server) => ({
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
            if (!event.candidate) return;

            console.log('[WebRTC] local ICE candidate', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });

            this.signaling.send({
                type: 'CANDIDATE',
                sessionId: this.sessionId,
                target: this.peerId,
                candidate: event.candidate,
            });
        };

        this.pc.onconnectionstatechange = () => {
            const state = this.pc?.connectionState;
            console.log('[WebRTC] connection state:', state, {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            if (!state || state === this.lastConnectionState) return;

            this.lastConnectionState = state;
            if (state === 'connected') {
                this.isConnected = true;
                console.log('[WebRTC] peer connected', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                    role: this.isCaller ? 'caller' : 'callee',
                });
                void this.logSelectedCandidatePair();
                return;
            }

            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                this.isConnected = false;
                console.warn('[WebRTC] peer not connected', {
                    state,
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                    role: this.isCaller ? 'caller' : 'callee',
                });
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ICE connection state:', this.pc?.iceConnectionState, {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
        };

        this.pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        if (this.isCaller) {
            this.createDataChannel();
            void this.createOffer();
        }
    }

    setupDataChannel(dc: RTCDataChannel): void {
        this.dc = dc;
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            console.log('Data channel opened');
        };

        dc.onmessage = (event) => {
            void this.fileTransfer.handleIncomingMessage(event.data as string | ArrayBuffer | Blob);
        };

        dc.onclose = () => {
            console.log('Data channel closed');
        };

        dc.onerror = (error) => {
            console.error('Data channel error:', error);
        };
    }

    createDataChannel(): void {
        if (!this.pc || this.dc) return;
        const dc = this.pc.createDataChannel('data', { ordered: true });
        this.setupDataChannel(dc);
    }

    async HandlerOffer(offer: RTCSessionDescriptionInit): Promise<void> {
        if (!this.pc) {
            this.createPeerConnection();
        }
        if (!this.pc) return;

        try {
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
                type: 'ANSWER',
                sessionId: this.sessionId,
                target: this.peerId,
                sdp: answer.sdp ?? '',
            });
        } catch (error) {
            console.error('Failed to handle offer:', error);
        }
    }

    async HandleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        if (!this.pc) return;

        try {
            console.log('[WebRTC] received answer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            await this.pc.setRemoteDescription(answer);
            await this.flushPendingCandidates();
        } catch (error) {
            console.error('Failed to handle answer:', error);
        }
    }

    async HandleCandidate(candidate: RTCIceCandidateInit | RTCIceCandidate): Promise<void> {
        if (!this.pc) return;

        try {
            const normalized = candidate instanceof RTCIceCandidate ? candidate.toJSON() : candidate;
            if (!normalized?.candidate) return;

            if (!this.pc.remoteDescription) {
                console.log('[WebRTC] queue remote ICE candidate until remote description', {
                    sessionId: this.sessionId,
                    peerId: this.peerId,
                });
                this.pendingCandidates.push(normalized);
                return;
            }

            console.log('[WebRTC] add remote ICE candidate', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            await this.pc.addIceCandidate(new RTCIceCandidate(normalized));
        } catch (error) {
            console.error('Failed to add ICE candidate', error);
        }
    }

    destroy(): void {
        this.fileTransfer.destroy();

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
            this.pc.oniceconnectionstatechange = null;
            this.pc.ondatachannel = null;
            this.pc.close();
            this.pc = null;
        }

        this.isConnected = false;
        this.lastConnectionState = null;
        this.pendingCandidates = [];
    }

    private async createOffer() {
        if (!this.pc) return;
        try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            console.log('[WebRTC] sending offer', {
                sessionId: this.sessionId,
                peerId: this.peerId,
            });
            this.signaling.send({
                type: 'OFFER',
                sessionId: this.sessionId,
                target: this.peerId,
                sdp: offer.sdp ?? '',
            });
        } catch (error) {
            console.error('Failed to create offer:', error);
        }
    }

    private sendData(payload: string | ArrayBuffer): void {
        if (!this.dc || this.dc.readyState !== 'open') {
            throw new Error('data channel is not open');
        }
        if (typeof payload === 'string') {
            this.dc.send(payload);
            return;
        }
        this.dc.send(new Uint8Array(payload));
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
                    local: local
                        ? `${localCandidate.protocol ?? 'unknown'}:${localCandidate.address ?? 'unknown'}:${localCandidate.port ?? 'unknown'}`
                        : 'unknown',
                    remote: remote
                        ? `${remoteCandidate.protocol ?? 'unknown'}:${remoteCandidate.address ?? 'unknown'}:${remoteCandidate.port ?? 'unknown'}`
                        : 'unknown',
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

    private handleReceivedFile(file: ReceivedFile): void {
        console.log('[WebRTC] file received', {
            peerId: this.peerId,
            sessionId: this.sessionId,
            name: file.name,
            size: file.size,
            mime: file.mime,
        });

        const url = URL.createObjectURL(file.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

class FileTransfer {
    private peerId: string;
    sendRaw: (payload: string | ArrayBuffer) => void;
    onFileReceived?: (file: ReceivedFile) => void;
    onProgress?: (progress: number) => void;
    onTransferCompleted?: () => void;

    private filesQueue: File[] = [];
    private busy = false;
    private chunker: FileChunker | null = null;
    private digester: FileDigester | null = null;
    private lastProgress = 0;

    constructor(opts: {
        peerId: string;
        sendRaw: (payload: string | ArrayBuffer) => void;
        onFileReceived?: (file: ReceivedFile) => void;
        onProgress?: (progress: number) => void;
        onTransferCompleted?: () => void;
    }) {
        this.peerId = opts.peerId;
        this.sendRaw = opts.sendRaw;
        this.onFileReceived = opts.onFileReceived;
        this.onProgress = opts.onProgress;
        this.onTransferCompleted = opts.onTransferCompleted;
    }

    sendFiles(files: FileList | File[]): void {
        const list = Array.isArray(files) ? files : Array.from(files);
        for (const file of list) {
            this.filesQueue.push(file);
        }

        if (this.busy) return;
        void this.dequeueFile();
    }

    async handleIncomingMessage(message: string | ArrayBuffer | Blob): Promise<void> {
        if (typeof message !== 'string') {
            await this.onChunkReceived(message);
            return;
        }

        let parsed: TransferMessage;
        try {
            parsed = JSON.parse(message) as TransferMessage;
        } catch (error) {
            console.warn('[WebRTC] invalid transfer control message', { peerId: this.peerId, error });
            return;
        }

        console.log('[WebRTC] transfer message', { peerId: this.peerId, type: parsed.type });

        switch (parsed.type) {
            case 'header':
                this.onFileHeader(parsed);
                return;
            case 'partition':
                this.onReceivedPartitionEnd(parsed.offset);
                return;
            case 'partition-received':
                await this.sendNextPartition();
                return;
            case 'progress':
                this.onDownloadProgress(parsed.progress);
                return;
            case 'transfer-complete':
                await this.onTransferCompletedByPeer();
                return;
            default:
                return;
        }
    }

    destroy(): void {
        this.filesQueue = [];
        this.busy = false;
        this.chunker = null;
        this.digester?.abort(new Error('transfer destroyed'));
        this.digester = null;
        this.lastProgress = 0;
    }

    private async dequeueFile(): Promise<void> {
        const file = this.filesQueue.shift();
        if (!file) {
            this.busy = false;
            return;
        }

        this.busy = true;
        await this.sendFile(file);
    }

    private async sendFile(file: File): Promise<void> {
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size,
        });

        this.chunker = new FileChunker(
            file,
            (chunk) => this.sendRaw(chunk),
            (offset) => this.onPartitionEnd(offset),
        );

        await this.chunker.nextPartition();
    }

    private onPartitionEnd(offset: number): void {
        this.sendJSON({ type: 'partition', offset });
    }

    private onReceivedPartitionEnd(offset: number): void {
        this.sendJSON({ type: 'partition-received', offset });
    }

    private async sendNextPartition(): Promise<void> {
        if (!this.chunker || this.chunker.isFileEnd) {
            return;
        }
        await this.chunker.nextPartition();
    }

    private sendProgress(progress: number): void {
        this.sendJSON({ type: 'progress', progress });
    }

    private onDownloadProgress(progress: number): void {
        this.onProgress?.(progress);
    }

    private onFileHeader(header: Extract<TransferMessage, { type: 'header' }>): void {
        this.lastProgress = 0;
        this.digester?.abort(new Error('new file header arrived before previous file completed'));
        this.digester = new FileDigester(
            {
                name: header.name,
                mime: header.mime,
                size: header.size,
            },
            (file) => {
                this.onFileReceived?.(file);
                this.sendJSON({ type: 'transfer-complete' });
            },
        );

        this.digester.done.catch((error) => {
            console.error('[WebRTC] file digester failed', { peerId: this.peerId, error });
        });
    }

    private async onChunkReceived(chunk: ArrayBuffer | Blob): Promise<void> {
        if (!this.digester) {
            console.warn('[WebRTC] received chunk without file header', { peerId: this.peerId });
            return;
        }

        const asBuffer = chunk instanceof Blob ? await chunk.arrayBuffer() : chunk;
        if (!asBuffer.byteLength) return;

        this.digester.unchunk(asBuffer);
        const progress = this.digester.progress;
        this.onDownloadProgress(progress);

        if (progress - this.lastProgress < 0.01 && progress < 1) {
            return;
        }

        this.lastProgress = progress;
        this.sendProgress(progress);
    }

    private async onTransferCompletedByPeer(): Promise<void> {
        this.onDownloadProgress(1);
        this.chunker = null;
        this.busy = false;
        this.onTransferCompleted?.();
        await this.dequeueFile();
    }

    private sendJSON(message: TransferMessage): void {
        this.sendRaw(JSON.stringify(message));
    }
}
