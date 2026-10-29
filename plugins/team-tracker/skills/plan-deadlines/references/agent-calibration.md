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

## Ce se măsoară

Rândurile `conversation_estimate` cu marker `[pontaj:interval=<start>/<sfârșit>]` sunt
timpul activ măsurat al unei sesiuni de agent. Rămân **interzise** ca timp uman
consumat, ca capacitate viitoare sau ca ore scăzute dintr-un item (regula 6). Sunt în
schimb singura măsură a duratei agentului și servesc la două lucruri:

1. **Factorul agentului** — mediana `ore pontate de agent / estimate_hours_high` pe
   iteme terminate care au fost în planuri recente (ultimele ~14 zile, același proiect).
2. **Paralelismul efectiv** — pe fiecare zi, suma orelor agentului împărțită la
   reuniunea intervalelor lor. Mediana zilelor, între 1 și 4. Sub 3 zile măsurate rămâne 1.

## Citire

```sql
-- planuri recente și estimările lor
SELECT item.plan_id, item.source_type, item.source_id, item.estimate_hours_high
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
test arhivat, secțiune `shipped`). Scrie cele patru liste într-un JSON temporar și rulează:

```bash
node "<skill_dir>/scripts/agent-pace.mjs" "<agent_input.json>"
```

Rezultatul dă `agent_correction_factor`, `source_types.<tip>.p50/p75`, `parallelism`
și zilele din care a fost calculat. Salvează-l în `velocity_snapshot.agent_calibration`.

## Folosire

- Pentru fiecare candidat executat de agent: `calibrate-estimate.mjs` cu
  `--calibration-basis agent_measured --factor <agent_correction_factor>`; fără factor,
  dar cu ≥3 iteme terminate de același tip, `--sample-items/--p50-hours/--p75-hours`.
  Multiplicatorul de browser nu se mai aplică: eșantioanele includ deja verificarea.
  Multiplicatorul de risc rămâne.
- Un item a cărui execuție e a omului (verdict, test pe telefon, decizie) nu primește
  ore de agent; rămâne la regula existentă (nu consumă ore planificate).
- `daily-budget.mjs --parallelism <parallelism>`; la replanificare, `parallelism` în
  inputul `replan-context.mjs`. Câmpurile existente (`gross_daily_hours`,
  `committed_target_hours`, `day_stop_hours`) rămân ceasul omului. Coada se împachetează
  cu `agent_daily_hours` și `agent_committed_target_hours` (respectiv `agent_round_hours`).
- În propunere scrie ambele: „10h de ceas ≈ 25h de agent la paralelism 2,5 (măsurat pe
  26–28.10); coada: 23h estimate de agent”. Dacă nu există calibrare de agent, spune că
  estimările sunt la scară umană și probabil se termină mult mai repede.
- Paralelismul nu creează ore umane: pragul de oprire rămâne pe orele umane declarate,
  iar cardurile la care omul trebuie să răspundă tot din cele 10h ale lui se iau.
