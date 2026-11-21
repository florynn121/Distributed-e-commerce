'use strict';

const login = document.querySelector('#login');
const accessLogin = document.querySelector('#access-login');
const password = document.querySelector('#password');
const status = document.querySelector('#status');
const productsList = document.querySelector('#products');
const productCard = document.querySelector('#product-card');
const pending = new Map();
let mode;
let token;
let accessSession = false;
let submitting = false;

function showStatus(message, state = 'info') {
    status.textContent = message;
    status.dataset.state = state;
}

function updateButtons() {
    const signedIn = mode === 'local' ? Boolean(token) : accessSession;
    for (const button of productsList.querySelectorAll('button')) {
        button.disabled = submitting || !signedIn;
    }
}

function updateSignIn() {
    login.hidden = mode !== 'local' || Boolean(token);
    accessLogin.hidden = mode !== 'access' || accessSession;
    updateButtons();
}

async function request(path, options) {
    const response = await fetch(path, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        ...options
    });
    const isJson = /^application\/(?:problem\+)?json(?:[; ]|$)/i.test(
        response.headers.get('content-type') ?? ''
    );
    return { response, data: isJson ? await response.json() : null };
}

function remember(sku, key) {
    if (key) pending.set(sku, key);
    else pending.delete(sku);

    try {
        const name = `tech-store:checkout:${sku}`;
        if (key) sessionStorage.setItem(name, key);
        else sessionStorage.removeItem(name);
    } catch {
        // In-memory state still protects retries when browser storage is unavailable.
    }
}

function pendingKey(sku) {
    let key = pending.get(sku);
    if (key) return key;
    try {
        key = sessionStorage.getItem(`tech-store:checkout:${sku}`);
    } catch {
        // A new key below can still be reused in this page.
    }

    key ||= crypto.randomUUID();
    remember(sku, key);
    return key;
}

async function checkout(product) {
    submitting = true;
    updateButtons();
    showStatus(`Placing your ${product.name} order…`);

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Idempotency-Key': pendingKey(product.sku)
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const { response, data } = await request('/api/orders/checkout', {
            method: 'POST',
            headers,
            body: JSON.stringify({ sku: product.sku })
        });

        if (response.ok && data?.id != null) {
            remember(product.sku);
            showStatus(`Order #${data.id} placed for ${product.name}.`, 'success');
        } else if (response.status === 401 || response.type === 'opaqueredirect') {
            if (mode === 'local') {
                token = undefined;
                updateSignIn();
                password.focus();
                showStatus('Sign in again to retry your order.', 'error');
            } else {
                accessSession = false;
                updateSignIn();
                accessLogin.focus();
                showStatus('Sign in again to retry your order.', 'error');
            }
        } else if (response.status === 409) {
            remember(product.sku);
            showStatus('This request conflicts with an earlier order. Review your selection before starting again.', 'error');
        } else {
            showStatus(data?.detail ?? 'Checkout is unavailable. Try the same order again.', 'error');
        }
    } catch {
        showStatus('Could not confirm your order. Try the same order again.', 'error');
    } finally {
        submitting = false;
        updateButtons();
    }
}

login.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = login.querySelector('button');
    submit.disabled = true;
    try {
        const { response, data } = await request('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password.value })
        });
        if (!response.ok || !data?.token) {
            showStatus(data?.detail ?? 'Unable to sign in. Try again.', 'error');
            return;
        }

        token = data.token;
        password.value = '';
        showStatus('Signed in. Choose a product to place an order.');
        updateSignIn();
        productsList.querySelector('button')?.focus();
    } catch {
        showStatus('Unable to sign in. Try again.', 'error');
    } finally {
        submit.disabled = false;
    }
});

async function showCatalog() {
    const sessionRequest = request('/api/session').catch(() => null);
    const catalog = await request('/api/catalog');
    if (!catalog.response.ok || !Array.isArray(catalog.data?.products)) {
        throw new Error('Could not load the catalog. Reload the page to try again.');
    }

    const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: catalog.data.currency });
    for (const product of catalog.data.products) {
        const card = productCard.content.cloneNode(true);
        card.querySelector('h2').textContent = product.name;
        card.querySelector('.description').textContent = product.description;
        card.querySelector('.price').textContent = price.format(product.priceCents / 100);
        const button = card.querySelector('button');
        button.setAttribute('aria-label', `Place order for ${product.name}`);
        button.addEventListener('click', () => checkout(product));
        productsList.append(card);
    }
    showStatus('Checking sign-in…');

    const session = await sessionRequest;
    mode = session?.data?.mode === 'local' ? 'local' : 'access';
    accessSession = session?.response.ok && session.data?.mode === 'access';
    showStatus(accessSession ? '' : 'Sign in to place an order.');
    updateSignIn();
}

showCatalog().catch((error) => showStatus(error.message, 'error'));
