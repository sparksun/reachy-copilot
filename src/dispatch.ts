import { ReachyMini } from '@pollen-robotics/reachy-mini-sdk';

// Self-assign for host shell discovery
(window as unknown as { ReachyMini: typeof ReachyMini }).ReachyMini = ReachyMini;
window.dispatchEvent(new Event('reachymini:ready'));

const params = new URLSearchParams(window.location.search);
const isEmbed = params.get('embedded') === '1' || params.get('embed') === '1';

if (isEmbed) {
  void import('./embed');
} else {
  void import('@pollen-robotics/reachy-mini-sdk/host/auto').then(({ mountHost }) => {
    /**
     * Auth strategy (priority order):
     *
     * 1. HF_OAUTH_CLIENT_ID set → OAuth flow (recommended, works with shared robots)
     *    The OAuth token carries the HF Space context the signaling server uses to
     *    filter the robot list.  redirect_uri used by SDK: window.location.href at
     *    page load time, typically http://localhost:5173/
     *
     * 2. HF_TOKEN + HF_USERNAME set AND no clientId → devToken PAT
     *    Only works if you personally OWN the robot (not just shared-with you).
     *    The signaling server ignores shared robots for PAT connections.
     *
     * 3. Neither → production mode; HF substitutes __OAUTH_CLIENT_ID__ at serve time.
     */
    const oauthClientId = import.meta.env.HF_OAUTH_CLIENT_ID as string | undefined;
    const pat = import.meta.env.HF_TOKEN as string | undefined;
    const patUser = import.meta.env.HF_USERNAME as string | undefined;

    mountHost({
      appName: 'Reachy Copilot',
      appIconUrl: '/icon.svg',
      appEmoji: '🤖',
      enableMicrophone: true,
      // Prefer OAuth over PAT — OAuth produces a Space-scoped token the signaling
      // server recognises for shared-robot access.
      clientId: oauthClientId,
      // devToken fallback: only useful if you own the robot outright.
      // Drop it when an OAuth clientId is configured so OAuth takes precedence.
      devToken:
        !oauthClientId && pat && patUser
          ? { token: pat, userName: patUser }
          : undefined,
    });
  });
}

