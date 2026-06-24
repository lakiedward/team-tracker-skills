// round.workflow.js — Workflow-ul unei runde a Dispecerului
// ----------------------------------------------------------------------------
// RULEAZĂ ÎN SANDBOX-UL HARNESS-ULUI (tool-ul `Workflow`). Disponibile: agent(),
// parallel(), pipeline(), log(), phase(), budget. INDISPONIBILE: filesystem, Bash,
// git, `import`. ATENȚIE: Date.now(), Math.random() și `new Date()` fără argumente
// ARUNCĂ în acest sandbox — de aceea NU generăm aici niciun id/timestamp:
//   - `run_id` vine din `args` (îl generează CONDUCTORUL în firul principal).
//   - worktree-urile le creează MUNCITORUL (prima lui acțiune), nu scriptul.
//   - merge / cleanup le face CONDUCTORUL după ce acest Workflow întoarce rezultate.
//
// Model A (preview single-tenant): implementare în PARALEL → verificare SQL în
// PARALEL → verificare pe PREVIEW SERIALIZAT printr-un singur lease (un muncitor pe
// preview odată). Scriptul doar fanează muncitori și întoarce rezultate structurate.
// ----------------------------------------------------------------------------

export const meta = {
  name: 'orchestrate-round',
  description: 'O rundă: fan-out de muncitori pe itemele unui proiect, fiecare în worktree-ul lui; implement paralel, verify SQL paralel, verify preview serial (lease unic).',
  phases: [{ title: 'Implement' }, { title: 'Verify' }],
}

// --- args așteptate (pasate de conductor) -----------------------------------
// {
//   project_id:   number,            // tt_* project_id
//   slug:         string,            // slug-ul proiectului din projects.json (basename worktree)
//   repo_path:    string,            // calea absolută a repo-ului sursă
//   git:          boolean,           // true → worktrees; false → in-place serial (fără merge)
//   preview_name: string | null,     // ex. 'vite-dev'; null → fără verificare pe preview
//   preview_port: number | null,     // ex. 3000; null dacă preview_name e null
//   run_id:       string,            // timestamp generat de conductor (NU aici)
//   soft_cap:     number,            // plafon de concurență (informativ; motorul îl impune oricum)
//   items: [ { kind, id, title, description, worker_skill, no_worktree? } ],
// }

const items = Array.isArray(args.items) ? args.items : []
const WORKTREE_ROOT = 'C:/Users/lakie/Desktop/.orch-worktrees'
const SLUG = args.slug || 'proj'
const HAS_GIT = args.git !== false
const HAS_PREVIEW = !!args.preview_name

// Calea worktree-ului unui item — folosește args.run_id (NU Date/Math.random).
function worktreePath(it) {
  return `${WORKTREE_ROOT}/${args.run_id}/${SLUG}-${it.id}`
}
function branchName(it) {
  return `orch/${it.id}`
}

// Un item rulează fără worktree dacă proiectul n-are git SAU itemul e marcat
// explicit no_worktree (ex. auto-running-test-plans, care nu editează cod — D1).
function usesWorktree(it) {
  return HAS_GIT && !it.no_worktree
}

// D1 — cele 4 tipuri de muncitor, rutate după `it.worker_skill` (vine din triajul
// conductorului, Faza 1). Conductorul setează deja `no_worktree:true` pe itemele
// `auto-running-test-plans` (rulează planuri, nu editează cod). Aici derivăm un singur
// adevăr: editează acest skill cod în worktree, sau doar rulează/raportează?
//   - resolving-tt-bugs            → editează cod   (worktree, commit, merge)
//   - resolving-tt-features        → editează cod   (worktree, commit, merge)
//   - resolving-failed-test-plans  → POATE edita cod (worktree, commit, merge — ca bug/feature)
//   - auto-running-test-plans      → DOAR rulează    (no_worktree, fără commit, fără merge)
// `no_worktree` (oricum impus de conductor pentru auto-running) e singura sursă de adevăr
// pentru „nu produce diff de cod" — îl folosim și ca să NU cerem commit pe astfel de iteme,
// chiar dacă proiectul are git.
const TEST_RUNNER_SKILL = 'auto-running-test-plans'
function isTestRunner(it) {
  return it.no_worktree === true || it.worker_skill === TEST_RUNNER_SKILL
}

// Contractul JSON al muncitorului — identic cu „Orchestrator target mode" din
// skill-urile surori, + cheile worktree/branch adăugate în Milestone C.
const RESULT_SCHEMA = {
  type: 'object',
  required: ['item_id', 'outcome'],
  properties: {
    item_id: { type: 'number' },
    outcome: { enum: ['fixed', 'done', 'blocked'] },
    verify_channel: { enum: ['preview', 'sql', 'none'] },
    test_recommendation: { enum: ['ai', 'human', 'both', 'none'] },
    effort: { type: 'string' },
    summary: { type: 'string' },
    question: { type: 'string' },
    worktree: { type: 'string' },
    branch: { type: 'string' },
    needs_preview: { type: 'boolean' },
    // Poarta de verificare model-C: `true` DOAR pe rezultate întoarse de un agent de
    // verificare (Stage 2a/2b). Passthrough (verifier mort) și itemele care n-au trecut
    // prin niciun stage de verificare poartă `false` → conductorul NU le face merge.
    verified: { type: 'boolean' },
  },
}

// ----------------------------------------------------------------------------
// Promptul de IMPLEMENTARE (Stage 1). Muncitorul: creează worktree-ul (dacă e
// cazul) → rulează skill-ul în target mode → implementează + commit → ÎNTOARCE
// JSON, DAR NU verifică pe preview (verificarea-preview e serializată de Stage 2b).
// ----------------------------------------------------------------------------
function implementPrompt(it) {
  const wt = worktreePath(it)
  const branch = branchName(it)
  const lines = []

  lines.push(`Rulează skill-ul ${it.worker_skill} în ORCHESTRATOR TARGET MODE pentru un singur item.`)
  lines.push('')

  if (usesWorktree(it)) {
    lines.push('Prima ta acțiune: creează worktree-ul izolat și lucrează DOAR în el:')
    lines.push(`  git -C ${args.repo_path} worktree add -b ${branch} ${wt} HEAD`)
    lines.push(`TARGET_SOURCE_ROOT=${wt}`)
  } else if (isTestRunner(it)) {
    // auto-running-test-plans: RULEAZĂ un plan, nu editează cod. Fără worktree, fără merge.
    // TARGET_SOURCE_ROOT e rădăcina proiectului doar ca să citească .claude/launch.json și să
    // scrie evidența — NU modifica niciun fișier sursă și NU face commit.
    lines.push('Acest item RULEAZĂ un plan de test pe preview și scrie rezultate în DB — NU editează cod și NU creează worktree. Lucrează direct în repo_path (doar pentru .claude/launch.json și dir-ul de evidență); nu modifica fișiere sursă.')
    lines.push(`TARGET_SOURCE_ROOT=${args.repo_path}`)
  } else {
    // git=false: skill care POATE edita cod, dar fără izolare worktree → in-place serial.
    lines.push('Proiect FĂRĂ git (worktree indisponibil): lucrează direct în repo_path, fără să creezi worktree.')
    lines.push(`TARGET_SOURCE_ROOT=${args.repo_path}`)
  }

  lines.push(`TARGET_PROJECT_ID=${args.project_id}`)
  lines.push(`TARGET_ITEM_ID=${it.id}`)
  if (it.kind === 'feature') {
    lines.push("Sari și peste Step 3c (decision gate) — Dispecerul a preautorizat procesarea acestui item.")
  }
  lines.push('')
  lines.push(`Item: [${it.kind} #${it.id}] ${it.title}`)
  lines.push(`Descriere (brief canonic): ${it.description || '(fără descriere)'}`)
  lines.push('')

  // Canalul de verificare în acest Workflow.
  if (HAS_PREVIEW) {
    lines.push('VERIFICARE: în acest stage NU verifica pe preview. Implementează și, dacă itemul ar avea nevoie de verificare UI pe preview, NU porni preview-ul acum — setează needs_preview=true și verify_channel="preview"; Dispecerul rulează verificarea-preview separat, serializat (lease unic). Dacă poți verifica complet prin SQL impersonation, fă-o acum și setează verify_channel="sql".')
  } else {
    lines.push('VERIFICARE: acest proiect NU are preview configurat (preview_name=null). Verifică EXCLUSIV prin SQL impersonation (verify_channel="sql"). Dacă itemul cere obligatoriu verificare UI pe preview, întoarce outcome="blocked" cu question despre lipsa preview-ului. Setează întotdeauna needs_preview=false.')
  }
  lines.push('')

  lines.push('Reguli de incertitudine (NU ghici): dacă itemul e prea vag / are mai multe interpretări / cere o acțiune ireversibilă (migrare DB, ștergere de date, push la remote, trimitere în afara sistemului) / skill-ul și-a epuizat cele max 3 cicluri de retry / ai încredere mică în corectitudine → întoarce outcome="blocked" cu o question clară pentru user.')
  lines.push('')

  if (isTestRunner(it)) {
    // Test runner: niciun commit — nu produce diff de cod, scrie doar rezultate în DB.
    lines.push('NU face commit — acest item nu schimbă cod. Scrii doar rezultatele planului în DB (per item).')
  } else if (usesWorktree(it)) {
    lines.push('La final, dacă ai schimbat ceva, COMMIT în worktree:')
    lines.push(`  git -C ${wt} add -A && git -C ${wt} commit -m "orch: ${it.kind} #${it.id}"`)
  } else if (HAS_GIT) {
    lines.push('La final, dacă ai schimbat ceva, COMMIT in-place (fără worktree):')
    lines.push(`  git -C ${args.repo_path} add -A && git -C ${args.repo_path} commit -m "orch: ${it.kind} #${it.id}"`)
  }
  lines.push('')

  lines.push('Întoarce DOAR JSON-ul structurat din contractul skill-ului, ca ULTIM mesaj, cu cheile:')
  lines.push('  item_id, outcome, verify_channel, test_recommendation, effort, summary, question, needs_preview,')
  if (usesWorktree(it)) {
    lines.push(`  worktree="${wt}", branch="${branch}".`)
  } else {
    lines.push('  worktree="" (fără worktree), branch="" (fără branch).')
  }
  return lines.join('\n')
}

// ----------------------------------------------------------------------------
// Promptul de VERIFICARE (Stage 2). channel='sql' (paralel) sau 'preview' (serial).
// Muncitorul a implementat deja în worktree-ul lui; aici doar verifică și
// actualizează outcome-ul. La 'preview' deține lease-ul exclusiv pe :port.
// ----------------------------------------------------------------------------
function verifyPrompt(r, channel) {
  const wt = r.worktree || args.repo_path
  const lines = []
  lines.push(`Verifică itemul deja implementat #${r.item_id} prin canalul "${channel}".`)
  lines.push(`Lucrează în: ${wt}`)
  lines.push(`TARGET_PROJECT_ID=${args.project_id}`)
  lines.push(`TARGET_ITEM_ID=${r.item_id}`)
  lines.push('')
  if (channel === 'preview') {
    lines.push(`Ai LEASE-UL EXCLUSIV pe preview-ul ${args.preview_name}:${args.preview_port} pentru durata acestei verificări (ești singurul muncitor pe preview acum).`)
    lines.push(`Pornește sau refolosește preview-ul ${args.preview_name} pe portul ${args.preview_port}, conduce verificarea UI din worktree-ul de mai sus, apoi (dacă l-ai pornit tu) lasă-l curat pentru următorul muncitor.`)
  } else {
    lines.push('Verifică prin SQL impersonation (RLS / stare DB). Nu atinge preview-ul — alți muncitori pot rula verificări SQL în paralel.')
  }
  lines.push('')
  lines.push('NU schimba statusul sursei (Dispecerul deține write-back-ul). NU face merge.')
  lines.push('Întoarce DOAR JSON-ul structurat actualizat (aceleași chei ca la implementare; outcome reflectă rezultatul verificării: "fixed"/"done" dacă a trecut, "blocked" dacă verificarea a eșuat). Păstrează aceleași worktree și branch.')
  return lines.join('\n')
}

// ============================================================================
// Stage 1 — IMPLEMENTARE (paralel; fără verificare pe preview)
// ============================================================================
const impl = (await parallel(items.map((it) => () =>
  agent(implementPrompt(it), { label: `${it.kind}:${it.id}`, phase: 'Implement', schema: RESULT_SCHEMA })
))).filter(Boolean)

// Itemele blocate la implementare nu mai trec prin verificare.
const blocked = impl.filter((r) => r.outcome === 'blocked')

// D1 — itemele `no_worktree` (auto-running-test-plans) RULEAZĂ planul direct în Stage 1:
// rularea LOR ESTE verificarea. NU au worktree în care un verificator să intre și nu produc
// diff de cod, deci NU trec prin Stage 2a/2b și NU se merge-uiesc. Le scoatem din pipeline-ul
// de verificare aici și le stampilăm `verified:true` la final (un `done` de la un test-runner
// este un rezultat real, nu un passthrough neverificat — altfel conductorul l-ar parca degeaba).
// Cele blocate (planul nu s-a putut rula) rămân în `blocked` și cad în park, ca orice block.
const noWtIds = new Set(items.filter((it) => it.no_worktree === true).map((it) => it.id))
const isNoWorktreeResult = (r) => noWtIds.has(r.item_id)
const testRuns = impl
  .filter((r) => r.outcome !== 'blocked' && isNoWorktreeResult(r))
  .map((r) => ({ ...r, verified: true }))

// ============================================================================
// Stage 2a — VERIFICARE SQL (paralel; n-au resursă comună)
// ============================================================================
const sqlItems = impl.filter((r) => r.outcome !== 'blocked' && !isNoWorktreeResult(r) && r.verify_channel === 'sql' && !r.needs_preview)
// `parallel` întoarce un array index-aliniat cu `sqlItems`, cu `null` pentru agenții
// morți. Stampilăm `verified:true` DOAR pe pozițiile non-null și FORȚĂM `item_id` din
// sursa `sqlItems[i].item_id` (nu avem încredere în id-ul ecou al agentului — fix și
// pentru id-uri fantomă). Itemele cu agent mort (null) NU sunt verificate → cad în
// passthrough mai jos (cu `verified:false`).
const sqlRaw = sqlItems.length
  ? await parallel(sqlItems.map((r) => () =>
      agent(verifyPrompt(r, 'sql'), { label: `verify-sql:${r.item_id}`, phase: 'Verify', schema: RESULT_SCHEMA })
    ))
  : []
const sqlVerified = sqlRaw
  .map((v, i) => (v ? { ...v, item_id: sqlItems[i].item_id, verified: true } : null))
  .filter(Boolean)

// ============================================================================
// Stage 2b — VERIFICARE PREVIEW (SERIAL; lease unic pe preview)
// Doar dacă proiectul are preview. Fiecare item, pe rând — un singur muncitor
// pe preview la un moment dat (preview-ul e single-tenant).
// ============================================================================
const previewItems = HAS_PREVIEW
  ? impl.filter((r) => r.outcome !== 'blocked' && !isNoWorktreeResult(r) && r.needs_preview === true)
  : []
const previewVerified = []
for (const r of previewItems) {
  const v = await agent(verifyPrompt(r, 'preview'), { label: `verify-prev:${r.item_id}`, phase: 'Verify', schema: RESULT_SCHEMA })
  // Doar dacă verificatorul a întors ceva: stampilează `verified:true` și FORȚEAZĂ
  // `item_id` din sursa `r.item_id` (nu din id-ul ecou al agentului). Dacă verificatorul
  // a murit (v === null), itemul NU e împins aici — cade în passthrough cu `verified:false`.
  if (v) previewVerified.push({ ...v, item_id: r.item_id, verified: true })
}

// Catch-all: orice rezultat din `impl` care NU a fost nici blocat, nici verificat cu
// succes prin SQL, nici prin preview (ex. verify_channel="none"; needs_preview fără
// preview disponibil; SAU verificatorul a murit și parallel/await a întors null) — îl
// trecem mai departe ca rezultat de implementare cu `verified:false`, ca să nu dispară
// din ce vede conductorul, dar marcat clar drept NEVERIFICAT. Conductorul refuză să
// facă merge pe un verde cu `verified !== true` (poarta de verificare e treaba lui).
// Contul se face pe ID-uri din SURSĂ (impl), nu pe id-uri ecou — un verificator viu
// dar cu id greșit nu poate „fura" contabilitatea unui alt item.
const verifiedIds = new Set([
  ...sqlVerified.map((r) => r.item_id),
  ...previewVerified.map((r) => r.item_id),
  ...testRuns.map((r) => r.item_id), // test-runs sunt deja „verificate" prin rulare (D1)
])
const blockedIds = new Set(blocked.map((r) => r.item_id))
const passthrough = impl
  .filter((r) => !blockedIds.has(r.item_id) && !verifiedIds.has(r.item_id))
  .map((r) => ({ ...r, verified: false }))

// Itemele blocate la implementare n-au trecut prin niciun stage de verificare → `false`.
const blockedOut = blocked.map((r) => ({ ...r, verified: false }))

// ============================================================================
// REZULTAT — fiecare item din `impl` apare EXACT o dată: blocate la implementare
// + verificate SQL + verificate preview + test-runs (no_worktree, verificate prin rulare)
// + restul (passthrough). Conductorul (firul principal) face merge secvențial DOAR pe verzi
// cu `verified===true` ȘI cu worktree (sare merge-ul pentru `no_worktree`); restul → PARK.
// ============================================================================
return [...blockedOut, ...sqlVerified, ...previewVerified, ...testRuns, ...passthrough]
