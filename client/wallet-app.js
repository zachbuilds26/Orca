import { createAppKit } from '@reown/appkit';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

const connectButton = document.querySelector('[data-connect-wallet]');
const unlinkButton = document.querySelector('[data-unlink-wallet]');
const copy = document.querySelector('[data-wallet-copy]');
const state = document.querySelector('[data-wallet-state]');
const stateText = document.querySelector('[data-wallet-state-text]');
const addressNode = document.querySelector('[data-wallet-address]');
const browserPanel = document.querySelector('[data-browser-access]');
const browserForm = document.querySelector('[data-browser-form]');
const browserCodeInput = document.querySelector('[data-browser-code]');
const browserSubmit = document.querySelector('[data-browser-submit]');
const browserHint = document.querySelector('[data-browser-hint]');

const browserCodeFromUrl = new URLSearchParams(window.location.search).get('code')?.trim() || '';

let csrfToken = '';
let config = null;
let appKit = null;
let connectedAddress = null;

boot().catch((error) => showFatalError(error.message || 'Unable to start the Orca wallet screen.'));

async function boot() {
  const telegram = window.Telegram?.WebApp;

  if (telegram?.initData) {
    telegram.ready();
    telegram.expand();
    await openTelegramSession(telegram.initData);
    return;
  }

  showBrowserAccess('Open /wallet in Telegram to get a one-time browser code, or paste one here from the Orca bot.');
  bindBrowserForm();

  if (browserCodeFromUrl) {
    browserCodeInput.value = browserCodeFromUrl;
    await openBrowserSession(browserCodeFromUrl, true);
  }
}

async function openTelegramSession(initData) {
  setState('Authenticating Telegram session…');
  const session = await request('/api/miniapp/session', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });

  csrfToken = session.csrfToken;
  await finishBoot('telegram');
}

async function openBrowserSession(code, fromUrl = false) {
  const trimmed = String(code || '').trim();
  if (!trimmed) {
    showBrowserAccess('Paste the browser code from Telegram to continue.');
    return;
  }

  setBrowserBusy(true);
  setState('Opening browser session…');

  try {
    const session = await request('/api/browser/session', {
      method: 'POST',
      body: JSON.stringify({ code: trimmed }),
    });

    csrfToken = session.csrfToken;
    if (fromUrl) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    await finishBoot('browser');
  } catch (error) {
    showBrowserAccess(error.message || 'That browser code did not work.');
    setState(error.message || 'Browser code failed.', 'error');
  } finally {
    setBrowserBusy(false);
  }
}

async function finishBoot(mode) {
  config = await request('/api/miniapp/config');

  if (!config.projectId) {
    throw new Error('Wallet connection needs a Reown project ID. Add REOWN_PROJECT_ID to Orca’s server configuration, then reopen this screen.');
  }

  const wallet = await request('/api/wallet');
  initializeAppKit();
  bindWalletControls();

  browserPanel.hidden = true;
  connectButton.hidden = false;
  connectButton.disabled = false;
  unlinkButton.disabled = false;
  unlinkButton.hidden = !wallet.wallet;

  if (wallet.wallet) {
    showLinkedWallet(wallet.wallet);
    return;
  }

  connectButton.textContent = 'Connect wallet';
  setState(mode === 'browser' ? 'Browser session ready' : 'Ready to connect', 'ready');
  copy.textContent = mode === 'browser'
    ? `Open an EVM wallet in your browser, switch to X Layer testnet (chain ${config.chainId}), and verify it once.`
    : `Connect an EVM wallet and verify it for X Layer testnet (chain ${config.chainId}).`;
}

function initializeAppKit() {
  if (appKit) {
    return;
  }

  const xLayerTestnet = {
    id: config.chainId,
    name: 'X Layer Testnet',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: 'OKX Explorer', url: config.explorerUrl } },
  };

  appKit = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [xLayerTestnet],
    defaultNetwork: xLayerTestnet,
    projectId: config.projectId,
    metadata: {
      name: 'Orca',
      description: 'Telegram-native X Layer testnet intent agent',
      url: config.appOrigin,
      icons: [],
    },
    features: { analytics: false, email: false, socials: false },
  });

  appKit.subscribeAccount((account) => {
    connectedAddress = account?.isConnected ? account.address : null;

    if (connectedAddress) {
      connectButton.textContent = 'Verify connected wallet';
      setState(`Wallet connected: ${shortAddress(connectedAddress)}`, 'ready');
    } else if (!addressNode.hidden) {
      setState('Wallet disconnected', 'error');
    }
  });
}

async function connectOrVerify() {
  try {
    if (!connectedAddress) {
      appKit.open({ view: 'Connect' });
      return;
    }

    connectButton.disabled = true;
    setState('Switching to X Layer testnet…');

    const provider = appKit.getWalletProvider();
    if (!provider?.request) {
      throw new Error('Your wallet provider is unavailable. Reconnect and try again.');
    }

    await ensureXLayerNetwork(provider);
    setState('Preparing secure ownership message…');

    const nonce = await request('/api/wallet/link-nonce', {
      method: 'POST',
      headers: { 'x-orca-csrf': csrfToken },
      body: JSON.stringify({ address: connectedAddress, chainId: config.chainId }),
    });

    setState('Approve the ownership signature in your wallet…');
    const signature = await provider.request({
      method: 'personal_sign',
      params: [nonce.message, connectedAddress],
    });

    setState('Verifying wallet ownership…');
    const linked = await request('/api/wallet/link-verify', {
      method: 'POST',
      headers: { 'x-orca-csrf': csrfToken },
      body: JSON.stringify({ nonceId: nonce.nonceId, address: connectedAddress, signature }),
    });

    showLinkedWallet(linked.wallet);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
  } catch (error) {
    setError(error.message || 'Wallet connection failed.');
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
  } finally {
    connectButton.disabled = false;
  }
}

async function ensureXLayerNetwork(provider) {
  const currentChain = await provider.request({ method: 'eth_chainId' });
  if (String(currentChain).toLowerCase() === config.chainHex.toLowerCase()) {
    return;
  }

  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chainHex }] });
  } catch (error) {
    if (error?.code !== 4902) {
      throw new Error('Switch to X Layer testnet in your wallet, then try again.');
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: config.chainHex,
        chainName: 'X Layer Testnet',
        nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
        rpcUrls: [config.rpcUrl],
        blockExplorerUrls: [config.explorerUrl],
      }],
    });
  }
}

async function unlinkWallet() {
  try {
    unlinkButton.disabled = true;
    await request('/api/wallet', { method: 'DELETE', headers: { 'x-orca-csrf': csrfToken } });
    addressNode.hidden = true;
    unlinkButton.hidden = true;
    connectButton.hidden = false;
    connectButton.textContent = 'Connect wallet';
    copy.textContent = `Connect an EVM wallet and verify it for X Layer testnet (chain ${config.chainId}).`;
    setState('Wallet disconnected', 'ready');
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
  } catch (error) {
    setError(error.message || 'Could not disconnect this wallet.');
  } finally {
    unlinkButton.disabled = false;
  }
}

function showLinkedWallet(wallet) {
  addressNode.textContent = wallet.address;
  addressNode.hidden = false;
  connectButton.hidden = true;
  unlinkButton.hidden = false;
  browserPanel.hidden = true;
  copy.textContent = 'This wallet is verified for Orca. New Telegram or browser sessions will use it as the X Layer testnet receiving address.';
  setState(`Verified on X Layer testnet · ${shortAddress(wallet.address)}`, 'ready');
}

function showBrowserAccess(message) {
  browserPanel.hidden = false;
  connectButton.hidden = true;
  unlinkButton.hidden = true;
  browserSubmit.disabled = false;
  browserCodeInput.disabled = false;
  browserHint.textContent = message;
  copy.textContent = 'Desktop browsers and mobile wallet browsers can use the same one-time code from Telegram.';
  setState('Browser code required', 'ready');
  browserCodeInput.focus();
}

function bindBrowserForm() {
  if (browserForm.dataset.bound === 'true') {
    return;
  }

  browserForm.dataset.bound = 'true';
  browserForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openBrowserSession(browserCodeInput.value);
  });
}

function bindWalletControls() {
  if (connectButton.dataset.bound === 'true') {
    return;
  }

  connectButton.dataset.bound = 'true';
  connectButton.addEventListener('click', connectOrVerify);
  unlinkButton.addEventListener('click', unlinkWallet);
}

function setBrowserBusy(isBusy) {
  browserCodeInput.disabled = isBusy;
  browserSubmit.disabled = isBusy;
  browserSubmit.textContent = isBusy ? 'Opening…' : 'Open browser session';
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function setState(message, variant = '') {
  state.classList.remove('is-ready', 'is-error');
  if (variant) {
    state.classList.add(`is-${variant}`);
  }
  stateText.textContent = message;
}

function setError(message) {
  setState(message, 'error');
  copy.textContent = 'Return to the Orca bot, reopen /wallet, and try again.';
  connectButton.disabled = true;
}

function showFatalError(message) {
  showBrowserAccess(message);
  setState(message, 'error');
  connectButton.disabled = true;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
