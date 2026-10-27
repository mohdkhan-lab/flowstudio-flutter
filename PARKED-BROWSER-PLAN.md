# FlowStudio — Parked Browser + ACTIVE chip: deep research (2026-10-23)

Owner ki maang (2026-10-23, WhatsApp): FlowStudio ZDola jaisa ho —
1. Browser band karne par bhi kaam proper chale, kitne bhi accounts ek saath chal rahe hon.
2. Chrome khol kar dekhe to sab live dikhe jaisa kaam ho raha hai.
3. Dekhna sirf cookie line ke Chrome button se ho.
4. Jis account par video ban rahi ho, uski cookie line par ACTIVE show ho.

## Aaj ka sach (code se verify kiya)

- Har account = apna dedicated Chrome profile (%APPDATA%\FlowStudio Lite). Cookie accounts ki cookies usi profile me inject hoti hain; parsed cookies app data me bhi stored (re-check ke liye).
- Generation: `launchBrowserForAccount` (flowAutomation.js) har WORKING account ke liye system ke asal Chrome ka ALAG process launch karta hai (Puppeteer). Concurrency Settings "Browsers" se capped (workerPool: max 5).
- Background mode (browserMode.js): wahi asal Chrome, window off-screen (-32000,-32000), NORMAL state, anti-throttling flags + CDP focus emulation. Do purane tareeke PC par FAIL ho chuke: headless 'new' (v2.4.0 — Flow pages aadhe load, prompt bar gayab, renders ruk gaye) aur minimized (v2.5.0/v2.6.0 — renders 1% par 8+ min freeze, throttling).
- Chrome ↗ button (sidebar_accounts.dart `openChrome` -> accountStore `openLoginWindow`): us account ke profile ka visible Chrome kholta hai. LEKIN generation chal rahi ho to mana kar deta hai ("A video is generating on this account right now") — ek profile ek saath do Chrome nahi khol sakta. Aur generation shuru hon par open login window reclaim (band) ho jati hai.
- Cookie line chip: sirf READY/status. Generation ke liye koi ACTIVE chip NAHI hai. Engine ke paas data pehle se hai: liveBrowsers registry (kind 'generation') + worker->account binding.
- Code comment (launchBrowserForAccount): live Flow session apni cookies kaam ke dauraan ROTATE karti hai aur wo profile me rehti hain — isiliye generation copy-profile par nahi jati.

## Bojh ki asal wajah

Har working account = ek pura Chrome process-tree (browser + renderer + GPU + network...). 5 workers = 5 trees. Idle accounts ka Chrome khula NAHI rehta (launch sirf kaam ke samay hota hai) — bojh sirf working set par hai.

## Route B (ZDola-pura model) kyun Flow par nahi

- Ek Chromium process = ek hi user-data-dir. Kayi accounts ek process me = incognito contexts — disk par persist NAHI hote. Session rotation + profile persistence ka poora bojh haath se sambhalna padega; app-band beech me = rotated session kho sakti hai.
- Headless Flow par PC-test me fail ho chuka hai (hamara apna saboot).
- Profile-import accounts (device-key wale) context model me aa hi nahi sakte.
- ZDola Dola par isiliye chalta hai: wahan account = sirf cookies, profile/device bandish nahi, aur Dola headless me load ho jata hai.

## Route A (RECOMMENDED): Parked fleet + show/hide toggle + ACTIVE chip

1. Generation bilkul aaj jaisi (asal Chrome + asal profile) — login/session ka zero risk. Har working browser ki window default OFF-SCREEN parked (aaj ka background mode hi).
2. Cookie line ka Chrome button = Dikhao/Chhupao toggle:
   - Kaam chal raha hai -> USI browser ki window CDP Browser.setWindowBounds se off-screen se screen par aa jaye (wahi live page, wahi haal). Generation wale browser ko dekhna aaj IMPOSSIBLE hai (profile-busy mana) — ye us bandish ko khatm karta hai.
   - Dobara dabao -> window wapas off-screen park, kaam bina ruke chalta rahe.
   - Kaam nahi chal raha -> aaj ki tarah profile ka visible Chrome (Sign In/dekhne ke liye).
   - Imaandaar limit: window ka apna X dabane se window sach me band ho sakti hai (bina extension ke rokna pakka nahi). Hal: X = park hi karwana hai to button se chhupana sikhaana hoga; agar window band ho bhi jaye to engine usi profile se browser dobara khol kar queue resume kare (queue pehle se resume-supporting hai) — koi video dobara nahi banegi, koi credit dobara nahi katega (download-only retry wala purana usool).
3. Cookie line par ACTIVE chip: engine progress events ke saath account state bheje — kaam shuru: chip "● ACTIVE" (pulsing, sunehra) READY ki jagah/saath; video ban jaye: wapas READY. Data engine ke paas pehle se hai, sirf UI tak pahunchana hai. Saath me chaaho to line par chhota "video ban rahi hai…" text bhi.
4. Load: 50 accounts diye to bhi khule browsers Settings wale limit se zyada kabhi nahi honge — queue baakiyon ko line me rakhta hai. Koi extra viewer/login window khuli nahi rahegi (reclaim pehle se hai). ZDola jitna ek-process halka NAHI hoga (profile-per-process Chrome ki majboori hai), lekin aaj se halka aur sab se badh kar — band karne par kaam kabhi nahi rukega.

## Process (owner ke design usool par)

1. Design sample: cookie line par ACTIVE chip + Chrome button ke naye bartav ka mockup — pehle tasveer, approval baad me.
2. Ek-account test build: sirf Route A ka show/hide + ACTIVE, owner PC par parakh.
3. Pass ho to full release (Flutter repo, in-app updater se).
