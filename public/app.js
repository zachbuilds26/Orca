async function loadConfig() {
  const cta = document.querySelector('[data-orca-cta]');
  const walletCta = document.querySelector('[data-wallet-cta]');
  const stateChip = document.querySelector('[data-bot-state]');
  const chainNodes = document.querySelectorAll('[data-chain]');
  const priceNodes = document.querySelectorAll('[data-live-price]');

  try {
    const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Config request failed with ${response.status}`);
    }

    const config = await response.json();

    chainNodes.forEach((node) => {
      node.textContent = config.chainId || '1952';
    });

    priceNodes.forEach((node) => {
      node.textContent = config.currentPriceLabel || 'loading…';
    });

    if (config.botUrl && cta) {
      cta.href = config.botUrl;
      cta.target = '_blank';
      cta.rel = 'noreferrer';
    } else if (cta) {
      cta.href = '#telegram';
      cta.removeAttribute('target');
      cta.removeAttribute('rel');
    }

    if (config.browserWalletUrl && walletCta) {
      walletCta.href = config.browserWalletUrl;
      walletCta.target = '_blank';
      walletCta.rel = 'noreferrer';
    } else if (config.botUrl && walletCta) {
      walletCta.href = `${config.botUrl}?start=wallet`;
      walletCta.target = '_blank';
      walletCta.rel = 'noreferrer';
    } else if (walletCta) {
      walletCta.href = '#telegram';
      walletCta.removeAttribute('target');
      walletCta.removeAttribute('rel');
    }

    if (stateChip) {
      stateChip.classList.remove('is-live', 'is-warn', 'is-setup');

      if (config.telegramReady && config.executionReady) {
        stateChip.textContent = 'Live on Telegram';
        stateChip.classList.add('is-live');
      } else if (config.telegramReady || config.executionReady) {
        stateChip.textContent = config.telegramReady ? 'Telegram live' : 'Execution ready';
        stateChip.classList.add('is-warn');
      } else {
        stateChip.textContent = 'Setup pending';
        stateChip.classList.add('is-setup');
      }
    }
  } catch (error) {
    chainNodes.forEach((node) => {
      node.textContent = '1952';
    });

    priceNodes.forEach((node) => {
      node.textContent = 'loading…';
    });

    if (cta) {
      cta.href = '#telegram';
      cta.removeAttribute('target');
      cta.removeAttribute('rel');
    }

    if (walletCta) {
      walletCta.href = '#telegram';
      walletCta.removeAttribute('target');
      walletCta.removeAttribute('rel');
    }

    if (stateChip) {
      stateChip.classList.remove('is-live', 'is-warn');
      stateChip.classList.add('is-setup');
      stateChip.textContent = 'Setup pending';
    }

    console.warn('Orca config unavailable', error);
  }
}

loadConfig();
