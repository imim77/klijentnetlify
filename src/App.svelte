<script lang="ts">
  import { onDestroy } from 'svelte';
  import { WebRTCController } from './services/webrtccontroller.svelte';
  import { generateName, getAgentInfo } from './utilis/uaNames';

  const localAlias = generateName();
  const localDevice = getAgentInfo(navigator.userAgent);
  const controller = new WebRTCController(localAlias, localDevice);
  const debugIceMode = (import.meta.env.VITE_ICE_MODE || 'server').toLowerCase();
  const debugSignalingUrl = import.meta.env.VITE_SIGNALING_URL || `${location.protocol.startsWith('https') ? 'wss' : 'ws'}://${location.hostname}:9000/ws`;

  function sendFiles(peerId: string, event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    controller.sendFiles(peerId, input.files);
    input.value = '';
  }

  onDestroy(() => {
    controller.destroy();
  });
</script>

<main>
  <h1>FileSender</h1>
  <p>Status: {controller.connectionStatus}</p>
  <p class="debug">Debug: ICE={debugIceMode} | signaling={debugSignalingUrl}</p>
  <h2>I am known as {controller.myName || localAlias}</h2>
  <h2>Peers ({controller.peers.length})</h2>
  {#if controller.peers.length === 0}
    <p>Waiting for peers to join...</p>
  {:else}
    <ul>
      {#each controller.peers as peer}
        <li>
          <div>
            <strong>{peer.alias || 'Unnamed device'}</strong>
            <span>{peer.deviceModel || peer.deviceType || 'Unknown device'}</span>
            <span>{controller.connectionLabel(peer.id)}</span>
          </div>
          <div>
            <input
              type="file"
              multiple
              disabled={!controller.isPeerConnected(peer.id)}
              on:change={(event) => sendFiles(peer.id, event)}
            />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: 'Avenir Next', 'Segoe UI', sans-serif;
    background: linear-gradient(160deg, #f2f7f5 0%, #dfeee8 100%);
    color: #1a2a23;
  }

  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 2rem 1rem 3rem;
  }

  h1 {
    margin: 0 0 0.5rem;
  }

  h2 {
    margin-top: 2rem;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.75rem;
  }

  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    border: 1px solid #b8d1c4;
    border-radius: 10px;
    background: #ffffffcc;
    flex-wrap: wrap;
  }

  li div {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
  }

  span {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .debug {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    opacity: 0.7;
    word-break: break-all;
  }

  @media (max-width: 720px) {
    li {
      align-items: flex-start;
    }
  }
</style>
