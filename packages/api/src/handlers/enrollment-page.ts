import { randomBytes } from "node:crypto";

const icons = {
	mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
	key: '<path d="M15 7.5a3.5 3.5 0 1 1-3.4 4.3L4 19.5V22h3v-2h2v-2h2l1.2-1.2A3.5 3.5 0 0 1 15 7.5Z"/><circle cx="16" cy="11" r="1"/>',
	code: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h8"/>',
	person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
	check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
	alert: '<path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>',
	open: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
} as const;

const icon = (name: keyof typeof icons) =>
	`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;

const styles = `
:root{--page:#faf9f6;--card:#fff;--text:#191b21;--muted:#5a606b;--faint:#9aa0ab;--line:#e6e8ec;--border:rgba(25,27,33,.14);--brand:#fb5d22;--accent:#dc5518;--tint:#fff3ec;--ink:#182025;--ink-hover:#2a333b;--ok:#17a06b;--ok-bg:#e3f6ed;--ok-text:#0c6444;--err:#d92d20;--err-bg:#fef3f2;--err-text:#912018;color-scheme:light;font:15px/1.55 "Public Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--page)}
*{box-sizing:border-box}body{margin:0;min-height:100vh}
header{position:relative;background:#fff;border-bottom:1px solid var(--line);padding:16px clamp(16px,4vw,32px);font-weight:600}
header small{display:block;font-weight:400;color:var(--muted);font-size:13px}
.bar{position:absolute;left:0;right:0;bottom:-1px;height:4px;background:#f2f1ec}.bar span{display:block;height:100%;width:5%;background:var(--ink);transition:width .3s ease-in-out}
main{max-width:560px;margin:0 auto;padding:32px 16px 48px}
ol{list-style:none;display:flex;margin:0 0 28px;padding:0}
ol li{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;font-size:13px;color:var(--faint)}
ol li+li::before{content:"";position:absolute;top:15px;right:calc(50% + 20px);width:calc(100% - 40px);height:2px;background:var(--line)}
ol li.done+li::before{background:var(--ok-text)}
ol .dot{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:600;background:var(--line);color:var(--faint);border:2px solid var(--line)}
ol .dot svg{width:16px;height:16px;stroke:#fff;stroke-width:3}
ol li.active{color:var(--accent);font-weight:600}ol li.active .dot{background:var(--brand);border-color:var(--brand);color:#fff}
ol li.done{color:var(--muted)}ol li.done .dot{background:var(--ok);border-color:var(--ok)}
ol li.failed .dot{background:var(--err);border-color:var(--err);color:#fff}
.card{background:var(--card);border-radius:16px;box-shadow:0 1px 2px rgba(16,18,24,.05);border:1px solid rgba(25,27,33,.08);padding:clamp(24px,5vw,40px);text-align:center}
.avatar{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:var(--tint)}
.avatar svg,.button svg{width:28px;height:28px;fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.avatar.ok{background:var(--ok-bg)}.avatar.ok svg{stroke:var(--ok-text);stroke-width:2.4}.avatar.err{background:var(--err-bg)}.avatar.err svg{stroke:var(--err)}
h1{font-size:22px;line-height:1.3;margin:0 0 8px;outline:none}
.lead{color:var(--muted);margin:0 auto 24px;max-width:42ch}
.facts{list-style:none;padding:0;margin:0 0 28px;text-align:left;display:grid;gap:10px}
.facts li{display:flex;gap:10px;align-items:flex-start}.facts li::before{content:"";flex:none;width:6px;height:6px;margin-top:9px;border-radius:50%;background:var(--brand)}
.button{font:inherit;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;padding:10px 16px;border-radius:9px;border:0;background:var(--ink);color:#fff;cursor:pointer;text-decoration:none}
.button:hover{background:var(--ink-hover);box-shadow:0 6px 18px -6px rgb(24 32 37/.5)}.button svg{width:18px;height:18px;stroke:currentColor}
.button.secondary{background:#fff;color:var(--text);border:1px solid var(--border)}.button.secondary:hover{box-shadow:0 1px 3px rgba(47,43,67,.12)}
.button:disabled{opacity:.5;cursor:progress;box-shadow:none}
.button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--brand);outline-offset:3px}
.link{display:inline-flex;align-items:center;gap:6px;color:var(--accent);font-weight:600;text-decoration:none}.link svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2}
form{text-align:left;display:grid;gap:16px}label{font-weight:600}
input[type=password],input[type=email]{display:block;width:100%;font:inherit;padding:11px 12px;margin-top:6px;border:1px solid var(--border);border-radius:9px;background:#fff}
.hint{font-size:13px;color:var(--muted);margin:6px 0 0;font-weight:400}
.account{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;background:var(--page);border:1px solid rgba(25,27,33,.08);font-weight:600;overflow-wrap:anywhere}
.account svg{flex:none;width:22px;height:22px;fill:none;stroke:var(--ok-text);stroke-width:2.4}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400}.consent input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--ink)}
.notice{border-radius:12px;padding:12px 16px;margin:0 0 20px;text-align:left;background:var(--ok-bg);color:var(--ok-text)}
.notice.err{background:var(--err-bg);color:var(--err-text)}
.aside{margin-top:24px;padding-top:20px;border-top:1px solid var(--line);text-align:left;color:var(--muted);font-size:14px}
.aside .button{margin-top:12px}
footer{max-width:560px;margin:0 auto;padding:0 16px 32px;color:var(--muted);font-size:13px;text-align:center}
@media (max-width:480px){ol li:not(.active) .label{display:none}}
[hidden]{display:none!important}
`;

/** Self-contained sign-in page: no dashboard, third-party assets or browser storage. */
export function enrollmentPage(): Response {
	const nonce = randomBytes(24).toString("base64");
	return new Response(
		`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect a Claude subscription</title>
<style nonce="${nonce}">${styles}</style></head><body>
<header>Shared agents pool<small>Connect a Claude subscription</small><div class="bar"><span id="progress"></span></div></header>
<main>
<ol id="stepper" aria-label="Progress">
<li data-step="email"><span class="dot">1</span><span class="label">Email</span></li>
<li data-step="signin"><span class="dot">2</span><span class="label">Sign in</span></li>
<li data-step="code"><span class="dot">3</span><span class="label">Paste code</span></li>
<li data-step="confirm"><span class="dot">4</span><span class="label">Confirm</span></li>
<li data-step="done"><span class="dot">5</span><span class="label">Done</span></li>
</ol>
<section class="card" id="step-email" hidden>
<div class="avatar">${icon("mail")}</div>
<h1 tabindex="-1">Connect your Claude subscription</h1>
<p class="lead">This adds your subscription to the shared agents pool. Start with your work email: if it is on this pool's list, the next step lets you sign in with Claude.</p>
<form id="request">
<p class="notice err" id="email-error" role="alert" hidden></p>
<label for="email">Work email<input id="email" type="email" autocomplete="email" spellcheck="false" required maxlength="254"></label>
<button class="button" type="submit">Continue</button>
</form>
</section>
<section class="card" id="step-signin" hidden>
<p class="notice" id="signin-notice" role="status" hidden></p>
<div class="avatar">${icon("key")}</div>
<h1 tabindex="-1">Sign in with Claude</h1>
<p class="lead" id="signin-for" hidden>Use the Claude account of <strong id="signin-email"></strong>. Only connect an account you have permission to share.</p>
<ul class="facts">
<li>Claude opens in a new tab. Sign in and pick the account to share.</li>
<li>Your password stays with Claude. The pool only keeps the authorization it needs to run agents.</li>
<li>Claude then shows a code: you paste it here in the next step.</li>
</ul>
<button class="button" id="start" type="button">Continue to Claude ${icon("open")}</button>
</section>
<section class="card" id="step-code" hidden>
<div class="avatar">${icon("code")}</div>
<h1 tabindex="-1">Paste the code from Claude</h1>
<p class="lead" id="code-lead">Claude opened in a new tab. Once you have signed in, it shows an authorization code: copy it and paste it below.</p>
<form id="verify">
<label for="code">Authorization code<input id="code" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"><span class="hint">The code stays hidden on screen. Never paste it into chat.</span></label>
<button class="button" type="submit">Verify account</button>
</form>
<p class="aside">Closed the Claude tab? <a class="link" id="reopen" target="_blank" rel="noopener noreferrer">Open Claude sign-in again ${icon("open")}</a></p>
</section>
<section class="card" id="step-confirm" hidden>
<div class="avatar">${icon("person")}</div>
<h1 tabindex="-1">Is this the right account?</h1>
<p class="lead">Claude verified the account below. Check it before adding it to the pool.</p>
<form id="confirm">
<div class="account">${icon("check")}<span id="account"></span></div>
<label class="consent"><input id="consent" type="checkbox" required><span>I authorize the shared agents pool to use this subscription.</span></label>
<button class="button" type="submit">Add to the pool</button>
</form>
<p class="aside">Wrong account? Do not confirm: start again and sign in with the right one.<a class="button secondary" href="/pool-enroll">Start again</a></p>
</section>
<section class="card" id="step-done" hidden>
<div class="avatar ok">${icon("check")}</div>
<h1 tabindex="-1">Subscription connected</h1>
<p class="lead"><strong id="connected-account"></strong> is now part of the shared agents pool. You can close this page.</p>
<div class="aside"><strong>Changed your mind?</strong> Disconnect removes this account's saved authorization and pool membership. It stays available for 24 hours while this page is open; it does not sign you out of Claude or cancel your subscription.<button class="button secondary" id="disconnect" type="button">Disconnect</button></div>
</section>
<section class="card" id="step-error" hidden>
<div class="avatar err">${icon("alert")}</div>
<h1 tabindex="-1">This sign-in can't continue</h1>
<p class="lead" id="error-message"></p>
<p class="aside">Nothing was added to the pool from this step.<a class="button secondary" href="/pool-enroll">Start again</a></p>
</section>
<p id="status" class="notice err" role="alert" hidden></p>
</main>
<footer>Each step expires after 10 minutes. Nothing is added to the pool until you confirm.</footer>
<noscript><p class="notice err">JavaScript is required for this sign-in.</p></noscript>
<script nonce="${nonce}">
let token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
addEventListener('hashchange', () => { if (location.hash) location.reload(); });
const get = id => document.getElementById(id);
const steps = ['email', 'signin', 'code', 'confirm', 'done'];
let current = 'email';
function show(step) {
  const failed = step === 'error';
  const index = steps.indexOf(failed ? current : step);
  if (!failed) current = step;
  for (const name of [...steps, 'error']) get('step-' + name).hidden = name !== step;
  document.querySelectorAll('#stepper li').forEach((item, position) => {
    item.className = position < index || step === 'done' ? 'done' : position === index ? (failed ? 'failed' : 'active') : '';
    item.querySelector('.dot').innerHTML = item.className === 'done' ? '${icon("check")}' : String(position + 1);
    if (position === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  get('progress').style.width = Math.max(5, ((index + (step === 'done' ? 1 : 0)) / steps.length) * 100) + '%';
  (step === 'email' ? get('email') : get('step-' + step).querySelector('h1')).focus();
}
async function send(step, body) {
  const response = await fetch('/pool-enroll/' + step, {method:'POST', credentials:'omit', cache:'no-store', redirect:'error', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sign-in failed. Start again.');
  token = data.token || '';
  return data;
}
const post = (step, values) => send(step, {token, ...values});
function fail(error) {
  token = ''; get('code').value = '';
  get('error-message').textContent = error instanceof Error ? error.message : 'Sign-in failed. Start again.';
  show('error');
}
show(/^[A-Za-z0-9_-]{43}$/.test(token) ? 'signin' : 'email');
get('request').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; get('email-error').hidden = true;
  try {
    const data = await send('request', {email: get('email').value});
    get('signin-email').textContent = data.email; get('signin-for').hidden = false;
    show('signin');
  } catch (error) {
    get('email-error').textContent = error instanceof Error ? error.message : 'This email cannot connect. Ask the operator.';
    get('email-error').hidden = false; get('email').focus();
  } finally { event.submitter.disabled = false; }
});
get('start').addEventListener('click', async () => {
  const tab = window.open('', '_blank');
  get('start').disabled = true;
  try {
    const data = await post('start', {});
    const url = new URL(data.authUrl);
    if (url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize') throw new Error('Invalid sign-in destination. Ask for help.');
    get('reopen').href = url.href;
    if (tab) { tab.opener = null; tab.location.href = url.href; }
    else get('code-lead').textContent = 'Your browser blocked the new tab. Open Claude sign-in with the link below, sign in, then paste the code it shows.';
    show('code');
  } catch (error) { if (tab) tab.close(); fail(error); }
});
get('verify').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  const code = get('code').value.trim(); get('code').value = '';
  try { const data = await post('verify', {code}); get('account').textContent = data.email; show('confirm'); }
  catch (error) { fail(error); }
});
get('confirm').addEventListener('submit', async event => {
  event.preventDefault(); if (!get('consent').checked) return; event.submitter.disabled = true;
  try { await post('confirm', {consent:true}); get('connected-account').textContent = get('account').textContent; show('done'); }
  catch (error) { fail(error); }
});
get('disconnect').addEventListener('click', async () => {
  get('disconnect').disabled = true; get('status').hidden = true;
  try {
    await post('disconnect', {});
    get('account').textContent = ''; get('connected-account').textContent = ''; get('consent').checked = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    get('signin-notice').textContent = 'Subscription disconnected: it is no longer in the pool. You can connect again or close this page.';
    get('signin-notice').hidden = false;
    show('signin');
  } catch (error) {
    get('disconnect').disabled = false;
    get('status').textContent = 'Removal is not confirmed. ' + (error instanceof Error ? error.message : 'Keep this page open and ask for help with this seat.');
    get('status').hidden = false;
  }
});
</script></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
				"x-frame-options": "DENY",
				"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			},
		},
	);
}
