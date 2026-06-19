<div align="center">

# 🛍️ Meesho Lister
### *Self-healing browser automation that turns a single product walk-through into thousands of one-click listings.*

[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.44-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash--Lite-4285F4?logo=google&logoColor=white)](https://ai.google.dev)
[![Express](https://img.shields.io/badge/Express-4.19-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-3.4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Built end-to-end by a PM-Builder · React + Node + Playwright + Gemini · Runs 100% locally**

</div>

---

## 📖 Table of Contents

- [🎯 About](#-about)
- [✨ Highlights](#-highlights)
- [🚀 Quick Start](#-quick-start)
- [🗂️ Project Layout](#️-project-layout)
- [🛠️ Tech Stack](#️-tech-stack)
- [🔐 Auth & Login Flow](#-auth--login-flow)
- [🧑‍🤝‍🧑 Roles & RBAC](#-roles--rbac)
- [🧠 Application State — AppContext + WS](#-application-state--appcontext--ws)
- [📄 Pages](#-pages)
- [🧩 Components](#-components)
- [🤖 NLP & AI Routing](#-nlp--ai-routing)
- [🪝 Hooks & Utilities](#-hooks--utilities)
- [🛤️ End-to-End Flow](#️-end-to-end-flow)
- [⚠️ Known Limitations](#️-known-limitations)
- [🗺️ Roadmap](#️-roadmap)
- [🤝 Contributing](#-contributing)
- [📜 License](#-license)
- [👤 Author](#-author)

---

## 🎯 About

**Problem.** Meesho sellers list hundreds of similar products every week. Each listing requires ~5 minutes of identical clicking — pick the category, fill the same 30 fields, upload the same supplementary photos, type a fresh SEO title, generate a new SKU. Hours wasted on muscle-memory work that algorithms could handle.

**Solution.** A local agent that **records** a seller's full walk-through of Meesho's "Add Catalog" form **once**, then **replays** it on demand. Drop in *N* hero images, hit *Run*, and the agent fills the form *N* times with fresh AI-generated copy, unique SKUs, and the same shared photo library — all while you watch in a real Chromium window. When Meesho's UI inevitably shifts, **Gemini steps in to re-locate the broken selector**, persists the fix, and continues. The path self-heals.

**Why it matters.** Reduces listing time from ~5 min to ~30 s. **Cuts cognitive load to zero** for repetitive work. Keeps photos on-device (only text touches the cloud). Costs ~₹0 to run on Gemini's free tier.

**What I built (as PM + Builder).**
- **Scoped** the problem from "automate Meesho" to "record-then-replay with AI fallback" after watching real seller workflows.
- **Architected** a record/run split so a non-technical user does the hard work once, then operates a single-button UI forever after.
- **Engineered** three layers of resilience: CSS-with-text fallbacks → Gemini-assisted recovery → human-in-the-loop overlay — each capable of self-healing the path config so later runs are fully autonomous.
- **Shipped** end-to-end UX: live WebSocket logs, batch-listing progress, masked credential storage, in-app path editor, and a recovery overlay overlaid on the live browser.
- **Validated** by running real listings against my Meesho seller account.

---

## ✨ Highlights

> Built. Shipped. Battle-tested.

- 🎬 **Record once, run forever.** A custom in-browser overlay captures every click, dropdown, and field while the user walks through Meesho's form. Output: a portable JSON path config.
- 🚀 **One-click batch listings.** Upload N hero images → app creates N listings sequentially, sharing one Chromium session and one Gemini call.
- 🤖 **Gemini-powered self-healing navigation.** When a recorded selector fails, the agent snapshots the page, asks Gemini to pick the right element, persists the fix, and continues. Path stabilizes after 1-2 runs.
- 🛡️ **Three-layer click resilience.** Normal click → force-click (overlay-pierce) → AI fallback → manual recovery overlay — graceful degradation through every failure mode.
- ✍️ **SEO + GEO-aware copywriting.** Single Gemini call generates product title (front-loaded keywords) and description (≤1300 chars, India-specific tonal cues) per batch.
- 🆔 **Collision-free SKU generation.** Pattern-based (`WH_FURR/X`) with persistent dedup ledger. Never repeats across 90,000-entry namespace.
- 🔐 **Local-first credentials.** All secrets live in `.env`. Sessions persist via Chromium profile directory. Photos never leave the device.
- ⚡ **Active readiness checks.** Dynamic `waitForLoadState` + `waitForSelector` replaces fixed delays — pages settle when ready, not on a guess.
- 🔄 **Skip-login auto-detection.** Recorded login flow is automatically skipped when the persistent profile is already authenticated.
- 📝 **In-app editor.** Rename path, swap shared images, flip fields between AI / Fixed / SKU, edit AI prompts — without touching JSON.

---

## 🚀 Quick Start

```bash
git clone https://github.com/yatinbhalla/Meesho-listing
cd Meesho-listing
npm install
npm run install:browsers     # downloads Chromium for Playwright (~150 MB)
cp .env.example .env         # fill in MEESHO_EMAIL, MEESHO_PASSWORD, GEMINI_API_KEY
npm start                    # opens http://localhost:5173
```

Get a free Gemini API key at <https://aistudio.google.com/app/apikey>. The `flash-lite` model gives ~1500 calls/day on the free tier — enough for hundreds of listings.

---

## 🗂️ Project Layout

```text
Meesho-listing/
├── 📁 src/
│   ├── 📁 server/                    Express + WebSocket backend (port 3001)
│   │   ├── index.js                  Express bootstrap + WS server + session lock
│   │   ├── 📁 routes/
│   │   │   ├── paths.js              CRUD + image upload for path configs
│   │   │   ├── record.js             Triggers recorder (long-running, async)
│   │   │   ├── run.js                Orchestrates AI gen → SKU → executor (batch)
│   │   │   ├── settings.js           Read/write .env via masked API
│   │   │   └── skus.js               Used-SKU history
│   │   └── 📁 middleware/upload.js   Multer config (10 MB, image-only)
│   │
│   ├── 📁 browser/                   Playwright agents (run in Node)
│   │   ├── session.js                Persistent profile, skip-login on reuse
│   │   ├── recorder.js               In-browser overlay; captures walk-through
│   │   └── executor.js               Replays path · retry · AI nav · recovery
│   │
│   ├── 📁 ai/                        Gemini integration
│   │   ├── client.js                 Shared call wrapper · model fallback · JSON mode
│   │   ├── generator.js              SEO + GEO product copy · unique SKUs
│   │   └── navigator.js              Page-aware element finder · self-heals selectors
│   │
│   ├── 📁 client/                    React 18 + Vite + Tailwind (port 5173)
│   │   ├── App.jsx                   View router + WSContext provider
│   │   ├── 📁 components/            Sidebar, ListingForm, RecordWizard, PathConfig, Settings, LiveLog
│   │   └── 📁 hooks/                 useWebSocket (auto-reconnect, StrictMode-safe)
│   │
│   └── 📁 types/models.js            JSDoc data models (PathConfig, FieldConfig, StepConfig)
│
├── 📁 paths/<name>/                  Saved path configs (gitignored if private)
│   ├── config.json                   Steps + fields + metadata
│   └── shared_images/                img2/3/4.jpg — reused per listing
│
├── 📁 data/                          Gitignored
│   ├── used_skus.json                SKU dedup ledger
│   ├── uploads/                      Ephemeral per-listing hero images
│   └── .browser-profile/             Chromium profile = Meesho session
│
├── 📁 test/                          Manual + smoke tests
│   ├── mock-form.html                Local form for executor smoke testing
│   ├── test-executor.js              Executor against mock form (no creds needed)
│   ├── test-sku.js                   Offline SKU generator + dedup test
│   ├── test-gemini.js                Live Gemini content generation
│   ├── test-navigator.js             Live AI nav recovery test
│   ├── list-models.js                Diagnostic: lists models accessible to your API key
│   └── ws-tail.mjs                   CLI WebSocket log tail for headless runs
│
└── 📄 .env / .env.example            Credentials (real .env is gitignored)
```

---

## 🛠️ Tech Stack

| Layer | Stack | Why |
|---|---|---|
| **Frontend** | React 18 · Vite · Tailwind CSS | Hot reload, near-zero config, Meesho-pink theme baked into Tailwind |
| **Backend** | Node 18 · Express · `ws` | Same-server WebSocket so the SPA can stream long-running automation logs |
| **Browser Automation** | Playwright (Chromium, headed) | Single library handles launch, persistent profiles, click intercept, file uploads |
| **AI** | `@google/generative-ai` · `gemini-2.5-flash-lite` | Generous free tier (~1500/day), sub-1s responses, JSON-mode output |
| **Storage** | Local JSON files | Zero database setup; per-user data stays on disk |
| **Process orchestration** | `concurrently` for `npm start` | Spawns Express + Vite in one command |

---

## 🔐 Auth & Login Flow

```
              First-ever run
                    │
                    ▼
       ┌─────────────────────────────┐
       │  launchPersistentContext()  │  → creates data/.browser-profile/
       └─────────────┬───────────────┘
                     ▼
              page.goto("/")
                     │
       Logged in? ◄──┴──► No
            │              │
            │              ▼
            │     Fill MEESHO_EMAIL + MEESHO_PASSWORD from .env
            │              │
            │     Multi-selector fallback (input[type=email],
            │     input[name=emailOrPhone], etc.)
            │              │
            │              ▼
            │     If auto-login fails → wait up to 3 min for manual login
            │              │
            └──────────────┤
                           ▼
                  Session cookies + LocalStorage
                  persisted in browser profile dir
                           │
              Next launch: skip login automatically
```

**Skip-login at replay time.** Recorded paths typically include the navigate-to-login step + email/password fills. At runtime, the executor detects that the URL is already post-login (i.e. on `/panel/...`) and **skips all login-flow steps** until the first real post-login navigate.

**Credential storage.** Never in code. Never in logs. Edit via the in-app Settings → Credentials tab, which masks secrets on display (`AIza••••pg`) and only PATCHes `.env` for fields the user actually changed.

---

## 🧑‍🤝‍🧑 Roles & RBAC

**This is a single-user desktop tool.** No multi-tenant model, no role hierarchy, no auth middleware. The only "role" is the OS user running `npm start` — they have full access to their own data, paths, and `.env`.

**Why no RBAC?** The app runs locally and never accepts inbound network traffic. Every Express route is bound to `localhost:3001`. Adding RBAC would be ceremony without benefit. If you fork this for a team/cloud deployment, the auth layer would slot in between the `cors`/`express.json` middleware and the route handlers.

---

## 🧠 Application State — AppContext + WS

State is **lifted to `App.jsx`** and shared via two mechanisms:

```jsx
// App.jsx
export const WSContext = createContext(null);
export const useWS = () => useContext(WSContext);

// State owned by App:
//   view              — 'welcome' | 'list' | 'record' | 'configure' | 'edit' | 'settings'
//   paths             — fetched on mount + after every mutation
//   selectedPath      — clicked in sidebar
//   configuringPath   — populated by 'recording_complete' WS event
//   editingPath       — populated when user clicks ✏️ Edit
```

**Why a shared WebSocket?** All long-running automation (record, run, batch) emits progress over a single WebSocket. Every screen that wants live logs subscribes to the same context — no socket-per-component, no message duplication, **StrictMode-safe** (an explicit teardown flag prevents the dev-mode ghost connection that doubles every log line).

---

## 📄 Pages

| Page | Triggered by | Purpose |
|---|---|---|
| **Welcome** | Default on first visit | Onboarding CTA → record first path |
| **Listing** (ListingForm) | Click a path in sidebar | Pick hero images, run batch, watch live log |
| **Record Wizard** | `+ Record New Path` | Two-step: intro → live recording, with the pink overlay panel injected into Chromium |
| **Path Configure** | Auto after `recording_complete` WS event | Mark fields AI/Fixed/SKU, upload 3 shared images |
| **Path Edit** | `✏️ Edit path` from Listing or Settings | Same as Configure, but for existing paths (rename, swap images, tweak fields) |
| **Settings** | Sidebar `⚙️ Settings` | Credentials · Paths management · Used SKU history |

---

## 🧩 Components

| Component | Responsibility |
|---|---|
| `Sidebar` | Lists saved paths with green/amber readiness badges, `+ Record New Path` and `⚙️ Settings` buttons |
| `ListingForm` | Multi-file hero image picker with live thumbnails, batch progress overlay, success/failure cards, embedded `LiveLog` |
| `RecordWizard` | Two-phase: intro instructions → live recording log. Auto-jumps to `PathConfig` when WS fires `recording_complete` |
| `PathConfig` | Dual-mode (`configure` / `edit`) — name, SKU pattern, description, per-field type selector (AI/Fixed/SKU/Image), shared image dropzone |
| `Settings` | Tabbed: `Credentials` (masked, PATCH-friendly) · `Paths` (edit/delete) · `Used SKUs` (audit list) |
| `LiveLog` | Topic-filtered (`run` / `record`), color-coded by `type`, auto-scrolls to latest, includes `clear` button and a connection status dot |

---

## 🤖 NLP & AI Routing

Two distinct AI surfaces, both routed through one shared client:

### 1. Content generation (`src/ai/generator.js`)

```
generateFields(fields, productDescription) →
   Single Gemini call · responseMimeType: 'application/json'
   Returns: { "Product Title": "...", "Description": "..." }
```

- **SEO-optimized title** — front-loads high-intent keywords, 50-80 chars.
- **SEO + GEO description** — India-specific tonal cues, ≤1300 chars, benefit-led bullets.
- **One call per batch**, not per listing — `productDescription` is constant under a path, so output is reused across all listings in a run.

### 2. Runtime navigation (`src/ai/navigator.js`)

```
findElementWithAI({ page, step, log }) →
   1. Snapshot every viewport-visible interactive element (≤80, tagged with data-meesho-ai-id)
   2. Build compact numbered list (tag · text · role · aria · id · testid · name · placeholder)
   3. Send to Gemini with: action, intent (step.label), original selector that failed
   4. Receive { index: N, reason: "..." }
   5. Re-compute stable selector for chosen element (id > testid > name > aria > role+text > text > class > path)
   6. Persist the corrected selector to paths/<name>/config.json
```

- Fires **only as fallback** — after CSS retries exhaust, before the manual recovery overlay.
- **Self-healing.** First run pays the AI cost; subsequent runs use the persisted selector with zero AI calls.
- Disable via `Settings → AI Navigation` checkbox or `AI_NAVIGATION_ENABLED=false`.

### Shared client (`src/ai/client.js`)

```
callGeminiJSON(prompt, { temperature, log }) →
   • Model fallback chain (lite first for free-tier quota)
   • Retry on 429 with server-suggested delay
   • MODEL_NOT_ACCESSIBLE detection — auto-advances to next model
   • JSON-mode with defensive code-fence stripping
```

Both `generator` and `navigator` import this; one place to tune cost, retry policy, and model rollout.

---

## 🪝 Hooks & Utilities

| Util | Purpose |
|---|---|
| `useWebSocket(onMessage?)` | Auto-reconnecting WS subscriber. Returns `{ messages, status, clear }`. StrictMode-safe — uses a teardown ref so dev-mount cleanup doesn't spawn a ghost connection that duplicates every log line |
| `useWS()` | Context-aware shortcut — every component reaches the shared WS without prop-drilling |
| `smartClick(page, selector)` | 3-layer click: normal → force (bypasses overlay intercept) → wait + force (handles late renders) |
| `waitForReady(page, step)` | Active page-readiness check — `domcontentloaded` + `networkidle` (bounded) + `waitForSelector(step.selector, 'attached', 15s)` |
| `getSelector(el)` *(in-browser)* | 8-tier selector generator: id → testid → name → aria-label → role+text → text → tag.class → nth-of-type path |
| `requestRecovery(page, step)` | Injects red banner with countdown timer; resolves with user-clicked element's selector or `null` on cancel/timeout (5 min) |
| `findClickTarget(el)` *(in recorder)* | Walks up to nearest semantic ancestor (`button`, `a`, `[role=button|option|...]`) instead of recording opaque wrapper divs |
| `isLoginUrl(url)` / `isPostLoginUrl(url)` | URL classifiers used by the skip-login-when-already-logged-in logic |

---

## 🛤️ End-to-End Flow

### Recording a path (once per product type)

```
User clicks "+ Record New Path"
      ↓
POST /api/record → 202 immediately
      ↓
Recorder opens persistent Chromium → already-logged-in via cookies
      ↓
addInitScript injects pink overlay panel + capture listeners
      ↓
User walks the form → every click/select/blur emitted via context.exposeFunction
      ↓
User clicks "Save & Finish" → modal collects name + SKU pattern + description
      ↓
PathConfig saved to paths/<safe-name>/config.json
      ↓
WS event "recording_complete" → UI auto-jumps to PathConfig screen
      ↓
User configures field types + uploads 3 shared images
      ↓
PATCH /api/paths/:name + POST /api/paths/:name/images
```

### Running a batch (daily use)

```
User selects path, drops N hero images, clicks "🚀 Run for N listings"
      ↓
POST /api/run (multipart, heroImages[]) → 202 immediately
      ↓
broadcast batch_start { total: N }
      ↓
Gemini generates AI fields ONCE for the batch (same description = same copy)
      ↓
Chromium opens / reuses session → already on dashboard
      ↓
For each hero image i in 1..N:
   • broadcast batch_item_start { index, sku }
   • Generate unique SKU
   • Replay path steps:
        - Skip about:blank navigates and login flow (when logged in)
        - For each step: waitForReady → executeStep → smartClick
        - On failure: 3 retries → AI nav fallback → recovery overlay
        - AI/recovery selectors are persisted to config.json
   • broadcast batch_item_complete { index, sku }
      ↓
broadcast batch_complete { skus: [...] }
      ↓
Cleanup: unlink all uploaded hero images. Browser stays open for review.
```

---

## ⚠️ Known Limitations

| Area | Limitation | Mitigation / Roadmap |
|---|---|---|
| **Selector fragility** | Meesho's React UI exposes few stable `id`/`name` attrs on dropdown options. Recorded selectors are positional in 60-80% of cases. | New recorder uses text/role/aria; AI nav heals breakage at runtime; path stabilizes after 1-2 runs. |
| **OTP / captcha login** | If Meesho introduces OTP or CAPTCHA, auto-login can't proceed. | Session.js detects login failure and gives the user 3 minutes to complete manually; profile then persists. |
| **Recording requires submit click** | For unattended batching, recordings must include the Submit button. Otherwise listings stack up unsubmitted. | Documented in setup flow; will add a recorder-time "did you click Submit?" prompt. |
| **AI nav free-tier limits** | `gemini-2.5-flash-lite` is ~1500 calls/day. Heavy first-run paths can consume 10-15. | Self-healing means subsequent runs are free; users can pin paid models via `GEMINI_MODEL`. |
| **Single-user, local only** | No multi-tenant deployment, no team paths, no cloud sync. | Intentional — keeps photos and credentials on-device. Cloud variant is a deliberate non-goal for v1. |
| **Browser stays open after run** | User must manually close Chromium between sessions or the next run reuses it. | Persistent-context reuse is the intended behavior; close button in the UI is on the roadmap. |
| **Pure-numeric labels** (`"518"`) | When dropdown options have only digits as visible text, AI nav has weak signal. | Recorded fill values (e.g. GST = `"5"`) help disambiguate; recovery overlay catches the rest. |
| **English-only AI copy** | Gemini prompts request English with India-specific context — no Hindi / regional variants yet. | Roadmap: locale-aware prompt templates. |

---

## 🗺️ Roadmap

- [ ] **Vision-augmented AI nav** — pass a viewport screenshot for layout-driven targets ("the 3rd row in the right sidebar").
- [ ] **Path versioning** — git-style history of config.json so users can roll back accidental selector edits.
- [ ] **Multi-locale AI copy** — Hindi / regional variants for non-English Meesho stores.
- [ ] **Bulk re-record helper** — semi-automated re-recording when Meesho ships a major UI redesign.
- [ ] **Listing analytics** — track which listings sold; feed back into the AI prompt as performance signal.
- [ ] **Headless mode toggle** — for power users who don't want to watch Chromium drive itself.
- [ ] **MCP server wrapper** — expose record/run as MCP tools so Claude / Gemini / GPT can drive listings directly.

---

## 🤝 Contributing

**Open to collaborators.** Pull requests, issues, and feature ideas are welcome.

If you'd like to contribute:

1. **Fork** the repo and create a feature branch (`git checkout -b feat/your-idea`).
2. **Run the smoke tests** locally before pushing — they're fast and don't need Meesho credentials:
   ```bash
   node test/test-sku.js           # offline
   node test/test-executor.js      # local mock form, no creds
   node test/test-gemini.js        # needs GEMINI_API_KEY
   node test/test-navigator.js     # needs GEMINI_API_KEY
   ```
3. **Open a PR** describing what you built, why, and what trade-offs you considered.

**Especially keen on contributions in:**
- Recorder selector strategies for other e-commerce platforms (Flipkart, Amazon Seller Central, Shopify admin).
- Vision-augmented AI navigation (Gemini multimodal).
- Locale-aware Gemini prompts.
- MCP / agent integration so this can be driven by external LLMs.

**Have an idea but don't want to code it?** Open an issue with the use case and a screenshot. Concrete user stories > clever code.

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — **free for any noncommercial use**: personal projects, learning, hobby use, research, and nonprofit/educational/government use. Fork it, modify it, share it.

**Commercial use is not permitted** under this license — you can't use it in a business to make or save money, ship it inside a paid product, or run it for an enterprise without a separate commercial license. Want to use it commercially? [Reach out](mailto:yatinbhalla42@gmail.com).

(And don't sue me when Meesho changes their UI — the software is provided "as is".)

---

## 👤 Author

**Yatin Bhalla** · Product Manager & AI Builder

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Yatin%20Bhalla-0A66C2?logo=linkedin&logoColor=white)](https://linkedin.com/in/yatinbhalla42)
[![Gmail](https://img.shields.io/badge/Gmail-yatinbhalla42%40gmail.com-EA4335?logo=gmail&logoColor=white)](mailto:yatinbhalla42@gmail.com)
[![X](https://img.shields.io/badge/X-@yatinbhalla42-000000?logo=x&logoColor=white)](https://x.com/yatinbhalla42)

<sub>If this project saved you time, a ⭐ on the repo makes my day. If it didn't — tell me why, and I'll fix it.</sub>
