import { randomBytes } from "node:crypto";

/** Self-contained sign-in page: no dashboard, third-party assets or browser storage. */
export function enrollmentPage(): Response {
	const nonce = randomBytes(24).toString("base64");
	return new Response(
		`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect a Claude subscription</title>
<style nonce="${nonce}">
:root{color-scheme:light;font-family:"Avenir Next",Avenir,"Segoe UI",sans-serif;color:#17334a;background:#edf3f7;line-height:1.6}
body{margin:0;padding:clamp(20px,6vw,64px)}main{max-width:42rem;margin:auto;background:#fff;padding:clamp(24px,5vw,48px);border-top:6px solid #235e82}
h1{font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.2;margin:0 0 24px}h2{font-size:1.2rem;margin-top:32px}p{max-width:65ch}button,a.button{font:inherit;display:inline-block;border:0;border-radius:6px;background:#235e82;color:#fff;padding:12px 20px;text-decoration:none;cursor:pointer}button:disabled{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #b15c00;outline-offset:4px}input[type=password]{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px;border:1px solid #647686;border-radius:4px;margin:8px 0 16px}label{display:block}#account{font-weight:600;overflow-wrap:anywhere}#status{white-space:pre-line}small{display:block;margin-top:32px;color:#4b6172}[hidden]{display:none!important}
</style></head><body><main>
<h1>Connect your Claude subscription</h1>
<p>This adds your subscription to the shared agents pool. Only connect an account you have permission to share. Your password stays with Claude; the pool stores the authorization needed to run agents.</p>
<section id="begin"><h2>1. Sign in with Claude</h2><p>You will open Claude in a separate tab. Choose the account you want to share.</p><button id="start" type="button">Connect Claude</button><p><a id="authorize" class="button" target="_blank" rel="noopener noreferrer" hidden>Open Claude sign-in</a></p></section>
<form id="verify" hidden><h2>2. Check your account</h2><label for="code">Paste the authorization code from Claude</label><input id="code" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"><button type="submit">Check account</button></form>
<form id="confirm" hidden><h2>3. Add this subscription</h2><p>Claude verified this account:</p><p id="account"></p><label><input id="consent" type="checkbox" required> I authorize the shared agents pool to use this subscription.</label><p><button type="submit">Add subscription to pool</button></p><p>Wrong account? Do not confirm. Close this page and ask the operator for a new link.</p></form>
<section id="connected" hidden><h2>Subscription connected</h2><p id="connected-account"></p><p>Testing this flow? Disconnect removes this seat's saved credentials and pool membership before letting you sign in again.</p><button id="disconnect" type="button">Disconnect and try again</button><p>Keep this page open to disconnect. This button expires after 24 hours; a page reload or server restart requires operator help. It does not sign you out of Claude's website, cancel your subscription, or stop a request already running.</p></section>
<p id="status" role="status" aria-live="polite"></p>
<small>This private link works once. After starting, each step expires in 10 minutes. Do not share this link or paste authorization codes into chat. Reloading this page requires a new invitation.</small>
<noscript>JavaScript is required for this private sign-in flow.</noscript>
</main><script nonce="${nonce}">
let token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
addEventListener('hashchange', () => { if (location.hash) location.reload(); });
const get = id => document.getElementById(id);
const status = get('status');
async function post(step, values) {
  const response = await fetch('/pool-enroll/' + step, {method:'POST', credentials:'omit', cache:'no-store', redirect:'error', headers:{'content-type':'application/json'}, body:JSON.stringify({token, ...values})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sign-in failed. Ask the operator for a new link.');
  token = data.token || '';
  return data;
}
function fail(error) {
  token = ''; get('code').value = ''; get('begin').hidden = true; get('verify').hidden = true; get('confirm').hidden = true;
  status.textContent = error instanceof Error ? error.message : 'Sign-in failed. Ask for a new link.';
}
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(new Error('Open the private invitation link supplied by your pool operator.'));
get('start').addEventListener('click', async () => {
  get('start').disabled = true;
  try {
    const data = await post('start', {});
    const url = new URL(data.authUrl);
    if (url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize') throw new Error('Invalid sign-in destination. Ask the operator for help.');
    get('authorize').href = url.href; get('authorize').hidden = false; get('start').hidden = true;
    get('verify').hidden = false; status.textContent = 'Open Claude sign-in above, then return here with the code.';
  } catch(error) { fail(error); }
});
get('verify').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const code = get('code').value.trim(); get('code').value = '';
  try { const data = await post('verify', {code}); get('begin').hidden = true; get('verify').hidden = true; get('account').textContent = data.email; get('confirm').hidden = false; status.textContent = 'Check the account above before confirming.'; }
  catch(error) { fail(error); }
});
get('confirm').addEventListener('submit', async event => {
  event.preventDefault(); if (!get('consent').checked) return; event.submitter.disabled = true;
  try { await post('confirm', {consent:true}); get('confirm').hidden = true; get('connected-account').textContent = get('account').textContent; get('connected').hidden = false; status.textContent = 'Subscription connected. If you are testing, disconnect before closing this page.'; }
  catch(error) { fail(error); }
});
get('disconnect').addEventListener('click', async () => {
  get('disconnect').disabled = true;
  try {
    await post('disconnect', {});
    get('connected').hidden = true; get('connected-account').textContent = ''; get('account').textContent = '';
    get('consent').checked = false; get('code').value = '';
    get('authorize').removeAttribute('href'); get('authorize').hidden = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    get('start').hidden = false; get('begin').hidden = false;
    status.textContent = 'Subscription disconnected. It is no longer in the pool. You can close this page or connect again.';
  } catch(error) {
    get('disconnect').disabled = false;
    status.textContent = 'Removal is not confirmed. ' + (error instanceof Error ? error.message : 'Keep this page open and ask the operator to check this seat.');
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
