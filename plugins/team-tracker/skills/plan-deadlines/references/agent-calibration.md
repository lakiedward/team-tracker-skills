# Calibrare pe timpul agentului și paralelism

Taskurile din coada zilei sunt executate de agent. Estimarea din cod are însă mărimea
unei zile de developer, iar calibrarea din `tt_delivery_calibration` acceptă doar ore
umane declarate. Pontajul real e aproape tot `conversation_estimate`, deci estimările
nu se corectau niciodată. Pe 26–28.10.2026 cozile de 10h s-au terminat în 1–2h de ceas:

| Proiect, zi | Estimat (sumă high) | Pontat de agent pe aceleași iteme | Raport | Ceas pentru coadă |
|---|---|---|---|---|
| Motion 26.10 (plan 175) | 12,5h | 3,45h | 0,28 | ~2h (08:58–10:58) |
| Motion 27.10 (plan 179) | 13h | 4,45h | 0,34 | ~1,5h (13:53–15:23) |
| Motion 28.10 (plan 180) | 15,75h | 5,38h | 0,34 | ~2,2h (12:02–14:13) |
| Betora 23.10 (plan 174) | 12h | 5,2h | 0,43 | ~2,5h |
| Betora 26.10 (plan 176) | 8h | 4,7h | 0,59 | ~1h (12:12–13:07) |
| Betora 27.10 (plan 177) | 12,5h | 2,97h | 0,24 | ~1,7h (09:06–10:46) |

Două cauze se înmulțesc: fiecare item e estimat de ~2,5–4 ori prea mare, iar mai multe
fire paralele livrează 1,7–3,6 ore de agent pe oră de ceas.

După 1.49.0 (planurile 181–188, 29.10–4.11) agentul a avut nevoie de 0,17–0,44 din
estimările deja calibrate. Factorul 0,43 a fost calculat o dată și refolosit
(`reused_from_plan`). Era comparat cu estimarea salvată, care era deja calibrată, deci
nu putea converge. De la 1.50.0 factorul se recalculează la fiecare plan, față de
estimarea brută.

## Ce se măsoară

Rândurile `conversation_estimate` cu marker `[pontaj:interval=<start>/<sfârșit>]` sunt
timpul activ măsurat al unei sesiuni de agent. Rămân **interzise** ca timp uman
consumat, ca capacitate viitoare sau ca ore scăzute dintr-un item (regula 6). Sunt în
schimb singura măsură a duratei agentului și servesc la două lucruri:

1. **Factorul agentului** — mediana `ore pontate de agent / estimarea brută high` pe
   iteme terminate care au fost în planuri recente (ultimele ~14 zile, același proiect).
   Estimarea brută este cea din cod, înainte de calibrare. Se ia din
   `velocity_snapshot.raw_estimates` (din 1.50.0). Pentru un plan 1.49.0 se reface din
   estimarea salvată împărțită la factorul aplicat de acel plan. Planurile mai vechi au
   salvat direct estimarea brută. `agent_correction_pair_bases` spune câte perechi vin din
   fiecare sursă.
2. **Mediana pe tip** — orele agentului pe item terminat, pe `source_type`. De la 3 iteme
   măsurate, mediana tipului este estimarea itemului.
3. **Paralelismul efectiv** — pe fiecare zi, suma orelor agentului împărțită la
   reuniunea intervalelor lor. Mediana zilelor, între 1 și 4. Sub 3 zile măsurate rămâne 1.
   Descrie zilele așa cum au fost rulate, deci rămâne doar ca reper.
4. **Utilizarea unui fir** — orele agentului împărțite la suma lungimilor intervalelor,
   mediana zilelor. `conveyor_parallelism` = `max_threads` × utilizarea (ex. 4 × 0,8 =
   3,2). Este paralelismul firelor pe care banda le pornește efectiv
   ([execuția zilei](day-execution.md)). Fără 3 zile măsurate, rămâne paralelismul istoric.

## Citire

```sql
-- planuri recente, cu snapshotul din care se refac estimările brute
SELECT plan.id, plan.velocity_snapshot
FROM public.tt_delivery_plans plan
WHERE plan.project_id = <project_id>
  AND plan.generated_at >= now() - interval '14 days';

-- itemele lor
SELECT item.plan_id, item.stable_key, item.source_type, item.source_id, item.estimate_hours_high
FROM public.tt_delivery_plan_items item
JOIN public.tt_delivery_plans plan ON plan.id = item.plan_id
WHERE plan.project_id = <project_id>
  AND plan.generated_at >= now() - interval '14 days';

-- Pontajul aceleiași perioade și legăturile lui
SELECT work.id, work.project_id, work.member, work.work_date, work.hours, work.description
FROM public.tt_work_logs work
WHERE work.project_id = <project_id> AND work.work_date >= current_date - 14;

SELECT link.work_log_id, link.source_type, link.source_id, link.allocated_hours, link.confidence
FROM public.tt_work_log_items link
JOIN public.tt_work_logs work ON work.id = link.work_log_id
WHERE work.project_id = <project_id> AND work.work_date >= current_date - 14;
```

`completed_sources` sunt sursele închise acum (bug `Fixed`, feature/To-Do gata, plan de
test arhivat, secțiune `shipped`). Scrie într-un JSON temporar `work_logs`, `links`,
`completed_sources`, `planned_items`, `plans` (id și `velocity_snapshot`), `max_threads`
(din instrucțiunile proiectului, implicit 4) și `planning_date`, apoi rulează:

```bash
node "<skill_dir>/scripts/agent-pace.mjs" "<agent_input.json>"
```

Rezultatul dă `agent_correction_factor`, `source_types.<tip>.p50/p75`, `parallelism`,
`thread_utilization`, `conveyor_parallelism` și zilele din care au fost calculate.
Salvează-l în `velocity_snapshot.agent_calibration`, cu `planning_date` al planului nou.
Rulează scriptul la fiecare plan, inclusiv la replanificarea din aceeași zi. Nu copia
factorul dintr-un snapshot anterior. O calibrare cu `reused_from_plan` sau cu altă
`planning_date` nu e validă.

## Folosire

- Pentru fiecare candidat executat de agent: `calibrate-estimate.mjs` cu
  `--calibration-basis agent_measured`, `--factor <agent_correction_factor>` și, când
  tipul are ≥3 iteme măsurate, `--sample-items/--p50-hours/--p75-hours`. Mediana tipului
  câștigă (`estimate_source: "type_median"`); factorul acoperă tipurile fără eșantion.
  Multiplicatorul de browser nu se mai aplică: eșantioanele includ deja verificarea.
  Multiplicatorul de risc rămâne. Un item vizibil mai mare decât unul obișnuit de tipul
  lui primește multiplicator de risc, cu motivul scris, sau o felie.
- Păstrează `raw_estimate_low/high` și `estimate_source` din rezultat în
  `velocity_snapshot.raw_estimates`, câte un rând pe item selectat, cu `stable_key`,
  `source_type` și `source_id`. Fără ele, factorul de mâine nu are față de ce să se
  măsoare.
- Un item a cărui execuție e a omului (verdict, test pe telefon, decizie) nu primește
  ore de agent; rămâne la regula existentă (nu consumă ore planificate).
- `daily-budget.mjs --parallelism <conveyor_parallelism>`; la replanificare,
  `parallelism` în inputul `replan-context.mjs`, tot cu `conveyor_parallelism`. Câmpurile existente (`gross_daily_hours`,
  `committed_target_hours`, `day_stop_hours`) rămân ceasul omului. Coada se împachetează
  cu `agent_daily_hours` și `agent_committed_target_hours` (respectiv `agent_round_hours`).
- În propunere scrie ambele: „10h de ceas, până la 20:22 ≈ 32h de agent cu 4 fire la
  utilizare 0,8; coada: 48h estimate de agent (1,5×)”. Dacă nu există calibrare de agent, spune că
  estimările sunt la scară umană și probabil se termină mult mai repede.
- Paralelismul nu creează ore umane. Execuția se oprește la ora de final a contractului
  de ceas ([execuția zilei](day-execution.md)), nu când se golește coada. Cardurile la
  care omul răspunde se adună în loturi.
