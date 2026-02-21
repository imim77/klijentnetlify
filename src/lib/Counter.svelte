<script lang="ts">
  import { onMount } from 'svelte';
  import { PeerManager } from '../services/peerManager';
  import {
    SignalingConnection,
    type ClientInfo,
    type WsServerMessage,
  } from '../services/signaling';

  let signaling: SignalingConnection | null = null;
  let peerManager: PeerManager | null = null;

  let me: ClientInfo | null = $state(null);
  let peers: ClientInfo[] = $state([]);
  let lastError = $state('');

  function shouldInitiate(peerId: string): boolean {
    if (!me) return false;
    return me.id.localeCompare(peerId) < 0;
  }

  function hasSessionForPeer(peerId: string): boolean {
    if (!peerManager) return false;
    for (const peer of peerManager.peersBySessionId.values()) {
      if (peer.peerId === peerId) return true;
    }
    return false;
  }

  function upsertPeer(peer: ClientInfo) {
    if (me && peer.id === me.id) return;

    const index = peers.findIndex((entry) => entry.id === peer.id);
    if (index < 0) {
      peers = [...peers, peer];
      return;
    }

    const next = peers.slice();
    next[index] = peer;
    peers = next;
  }

  function removePeer(peerId: string) {
    peers = peers.filter((peer) => peer.id !== peerId);
  }

  async function handleServerMessage(msg: WsServerMessage) {
    console.log('[WS] incoming:', msg.type, msg);
    await peerManager?.handleMessage(msg);

    switch (msg.type) {
      case 'HELLO':
        me = msg.client;
        peers = msg.peers.filter((peer) => peer.id !== msg.client.id);
        for (const peer of peers) {
          connectToPeer(peer.id, true);
        }
        break;
      case 'JOIN':
        upsertPeer(msg.peer);
        connectToPeer(msg.peer.id, true);
        break;
      case 'UPDATE':
        upsertPeer(msg.peer);
        break;
      case 'LEFT':
        removePeer(msg.peerId);
        break;
      default:
        break;
    }
  }

  function connectToPeer(peerId: string, isAutomatic = false) {
    if (!peerManager) return;

    if (isAutomatic && !shouldInitiate(peerId)) {
      console.log('[AUTO CONNECT] skipping (wait for remote offer):', peerId);
      return;
    }

    const alreadyConnected = hasSessionForPeer(peerId);
    if (alreadyConnected) {
      console.log('[CONNECT] session already exists:', peerId);
      return;
    }

    console.log(isAutomatic ? '[AUTO CONNECT] starting session to:' : '[CONNECT] starting session to:', peerId);
    peerManager.startSession(peerId);
  }

  onMount(() => {
    signaling = new SignalingConnection({
      info: { alias: `Browser-${Math.floor(Math.random() * 1000)}`, deviceType: 'Browser' },
      onOpen: () => {
        console.log('[WS] connected to signaling server');
      },
      onMessage: async (msg) => {
        try {
          await handleServerMessage(msg);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          console.error('Failed to handle WS message:', error);
        }
      },
      onClose: (event) => {
        console.log('[WS] signaling closed:', event.code, event.reason);
      },
      onError: (error) => {
        lastError = error instanceof Error ? error.message : String(error);
        console.error('Signaling error:', error);
      },
    });

    peerManager = new PeerManager({
      signaling,
      onPeerCreated: (peer) => {
        console.log('[PeerManager] peer session created', {
          sessionId: peer.sessionId,
          peerId: peer.peerId,
          isCaller: peer.isCaller,
        });
      },
      onPeerRemoved: (peer) => {
        console.log('[PeerManager] peer session removed', {
          sessionId: peer.sessionId,
          peerId: peer.peerId,
        });
      },
      onError: (error) => {
        lastError = error instanceof Error ? error.message : String(error);
        console.error('Peer manager error:', error);
      },
    });

    return () => {
      peerManager?.destroy();
      signaling?.destroy();
    };
  });
</script>

<section>
  <h2>Signaling</h2>
  <p>Me: {me ? `${me.alias || 'Anonymous'} (${me.id})` : 'Connecting...'}</p>
</section>

<section>
  <h2>Peers</h2>
  {#if peers.length === 0}
    <p>No peers online.</p>
  {:else}
    <ul>
      {#each peers as peer}
        <li>
          <strong>{peer.alias || 'Anonymous'}</strong>
          <code>{peer.id}</code>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if lastError}
  <p>Last error: {lastError}</p>
{/if}
