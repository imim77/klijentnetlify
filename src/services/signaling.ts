
export class SignalingConnection {
    socket: WebSocket | null = null;
    info: ClientInfoWithoutId | null;
    url: string = this._endpoint;
    _iceServers: IceServerInfo[] = [];
    _iceMode: IceMode = 'server';
    _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    _isDestroyed = false;
    _onOpen?: () => void;
    _onMessage?: (msg: WsServerMessage) => void;
    _onClose?: (e: CloseEvent) => void;
    _onError?: (err: unknown) => void;

    constructor(opts: {
        info?: ClientInfoWithoutId;
        onOpen?: () => void;
        onMessage?: (msg: WsServerMessage) => void;
        onClose?: (ev: CloseEvent) => void;
        onError?: (err: unknown) => void;
        endpoint?: string;
        iceMode?: IceMode;
    }) {
        this.info = opts.info ?? null; 
        this._iceMode = resolveIceMode(opts.iceMode);
        this.url = resolveSignalingEndpoint(opts.endpoint);

        this._onOpen = opts.onOpen;
        this._onMessage = opts.onMessage;
        this._onClose = opts.onClose;
        this._onError = opts.onError;

        this._connect();
    }

    send(msg: WsClientMessage){
        if (!this._isConnected()) return false;
        this.socket!.send(JSON.stringify(msg));
        return true;
    }

    getIceServers(): IceServerInfo[] {
        if (this._iceMode === 'none') {
            return [];
        }
        if (this._iceMode === 'stun') {
            return [defaultStunServer()];
        }
        if (this._iceServers.length > 0) {
            return this._iceServers;
        }
        return [defaultStunServer()];
    }

    getIceMode(): IceMode {
        return this._iceMode;
    }

    destroy(): void {
        this._isDestroyed = true;
        this._clearReconnectTimer();

        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onmessage = null;
            this.socket.onerror = null;
            this.socket.onclose = null;
            this.socket.close();
            this.socket = null;
        }
    }

    private _connect(){
        if (this._isDestroyed) return;
        if (this._isConnected() || this._isConnecting()) return;

        this._clearReconnectTimer();

        const ws = new WebSocket(this.url);

        ws.onopen = () => {
            if (this.info) {
                this.send({
                    type: 'UPDATE',
                    info: this.info,
                });
            }
            this._onOpen?.();
        };

        ws.onmessage = (event) => {
            let msg: WsServerMessage;
            try {
                msg = JSON.parse(event.data) as WsServerMessage;
            } catch (error) {
                this._onError?.(error);
                return;
            }

            if (msg.type === 'HELLO' && msg.iceServers) {
                this._iceServers = msg.iceServers;
            }

            this._onMessage?.(msg);
        };

        ws.onerror = (error) => {
            this._onError?.(error);
        };

        ws.onclose = (event) => {
            this._handleClose(event);
        };

        this.socket = ws;
    }

    private _handleClose(event: CloseEvent){
        this.socket = null;
        this._onClose?.(event);

        if (this._isDestroyed) return;

        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => this._connect(), 5000);
    }

    private get _endpoint(){
        return resolveSignalingEndpoint(undefined);
    }

    private _isConnected(){
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    private _isConnecting(){
        return this.socket !== null && this.socket.readyState === WebSocket.CONNECTING;
    }

    private _clearReconnectTimer(){
        if (!this._reconnectTimer) return;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }
}

function defaultStunServer(): IceServerInfo {
    return { urls: ['stun:stun.l.google.com:19302'] };
}

function resolveSignalingEndpoint(explicit?: string): string {
    const configured = explicit ?? import.meta.env.VITE_SIGNALING_URL;
    console.log(configured);
    const cleaned = (configured ?? '').trim();

    if (cleaned) {
        const normalized = normalizeUrl(cleaned);
        if (normalized) {
            return normalized;
        }
        console.warn('[Signaling] invalid VITE_SIGNALING_URL, falling back to local endpoint', cleaned);
    }

    const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
    return `${protocol}://${location.hostname}:9000/ws`;
    
}

function normalizeUrl(raw: string): string | null {
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
        return raw;
    }

    if (raw.startsWith('http://') || raw.startsWith('https://')) {
        try {
            const parsed = new URL(raw);
            parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
            if (!parsed.pathname || parsed.pathname === '/') {
                parsed.pathname = '/ws';
            }
            return parsed.toString();
        } catch {
            return null;
        }
    }

    if (!raw.includes('://')) {
        const prefixed = `ws://${raw}`;
        try {
            const parsed = new URL(prefixed);
            if (!parsed.pathname || parsed.pathname === '/') {
                parsed.pathname = '/ws';
            }
            return parsed.toString();
        } catch {
            return null;
        }
    }

    return null;
}

function resolveIceMode(explicit?: IceMode): IceMode {
    if (explicit) return explicit;
    const configured = (import.meta.env.VITE_ICE_MODE ?? '').toLowerCase();
    if (configured === 'none' || configured === 'stun' || configured === 'server') {
        return configured;
    }
    return 'server';
}




export interface ClientInfoWithoutId {
    alias: string;
    deviceModel?: string;
    deviceType?: string;
    token?: string;
}

export interface ClientInfo extends ClientInfoWithoutId {
    id: string;
}

export type WsClientMessage =
    | { type: 'OFFER'; sessionId: string; target: string; sdp: string }
    | { type: 'ANSWER'; sessionId: string; target: string; sdp: string }
    | { type: 'CANDIDATE'; sessionId: string; target: string; candidate: RTCIceCandidateInit | null }
    | { type: 'UPDATE'; info: ClientInfoWithoutId };

export type WsServerMessage =
    | { type: 'HELLO'; client: ClientInfo; peers: ClientInfo[]; iceServers?: IceServerInfo[] }
    | { type: 'JOIN'; peer: ClientInfo }
    | { type: 'UPDATE'; peer: ClientInfo }
    | { type: 'LEFT'; peerId: string }
    | OfferMessage
    | AnswerMessage
    | { type: 'CANDIDATE'; peer: ClientInfo; sessionId: string; candidate: RTCIceCandidateInit | null }
    | { type: 'ERROR'; code: number };

export interface OfferMessage {
    type: 'OFFER';
    peer: ClientInfo;
    sessionId: string;
    sdp: string;
}

export interface AnswerMessage {
    type: 'ANSWER';
    peer: ClientInfo;
    sessionId: string;
    sdp: string;
}

export interface IceServerInfo {
    urls: string[];
    username?: string;
    credential?: string;
}

export type IceMode = 'server' | 'stun' | 'none';
