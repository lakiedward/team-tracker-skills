---
name: borne
description: Use when the user wants to set, move, complete or review the intermediate milestones of a Team Tracker project — the thresholds between today and the deadline, such as an App Store submission, a client demo, a marketing launch or a page being closed — or invokes "/borne". It reads the project's live state first, proposes only milestones the tracker can justify, and ASKS for the ones only the human knows instead of inventing them. Shows a read-only proposal plus a diff and writes to tt_milestones only after explicit confirmation. Moving a milestone requires a written reason, the same discipline as /amana. It never edits tt_delivery_profiles.deadline — that date has its own place and its own gate. Triggers include "pune borne", "borne", "adaugă un deadline intermediar", "ce praguri avem", "când dăm drumul pe App Store", "mută borna", "am atins borna", "set milestones", "add a milestone", "move the milestone", "project timeline".
---

# borne — pragurile dintre azi și deadline, puse împreună

A project has one date the tracker knows: `tt_delivery_profiles.deadline`.
Everything between today and that date — the store submission, the client demo,
the marketing launch, the page that has to close before the rest can start —
lives in somebody's head.

The cost is visible on the Productivitate page: two projects with the same number
of days left look identical, even when one of them has three thresholds it can
miss and the other has none.

This skill fills that gap **in conversation**, and it has one rule that shapes
everything else:

> A milestone is either something the tracker can justify, or something only you
> know. The first kind gets proposed with its evidence. The second kind gets
> **asked for**. Neither gets invented.

## De ce contează distincția

An agent that guesses milestones produces a timeline that looks informative and
is fiction. „Beta pe 15 septembrie" written by a model that has never been told
about a beta is worse than an empty line, because the empty line does not lie.

So the two sources stay separate and are always labelled as such in the proposal:

**Derivate** — thresholds the tracker can defend, with the numbers that justify them:
- „toate secțiunile obligatorii livrate" — from `tt_section_pipeline`, counting rows
  where `is_unit = true` and `delivery_stage <> 'shipped'`, dated from the measured pace;
- „acoperirea criteriilor închisă" — from `criteria_uncovered` across the same rows;
- „backlogul de bug-uri High/Critical golit" — from `tt_bugs`.

**Numai ale tale** — nothing in the database implies them, so they are questions:
- submisia pe App Store / Google Play, și cât buffer lași pentru review;
- demo la client, prezentare, deadline contractual;
- lansare de marketing, campanie, eveniment.

## Flux

1. **Înrădăcinare.** Resolve the project from the argument or the cwd, exactly like
   the other skills. Refuse to guess between two projects.

2. **Citește starea reală înainte să propui.** Never open with a proposal:
   - `tt_delivery_profiles` — `deadline`, `launch_stage`, `weekly_capacity_hours`;
   - `tt_milestones` — bornele existente ale proiectului;
   - `tt_section_pipeline` — câte secțiuni mai au nevoie de criterii, teste, livrare;
   - `tt_bugs` / `tt_features` — ce e deschis;
   - planul curent din `tt_delivery_plans` și ritmul din Pontaj (`tt_work_logs`).

3. **Propune read-only, cu diff.** Same contract as `/plan-deadlines`: show what
   would be added, changed and removed, with the evidence next to each derived row
   and an explicit question for each human-only row. Nothing is written yet.

4. **Scrie doar după confirmare explicită.** „Da" to the proposal as a whole is
   enough; „da, dar fără a treia" is normal and must be honoured row by row.

5. **Verifică ce ai propus, și spune ce nu se leagă.** These checks are the reason
   this skill exists rather than an INSERT:
   - o bornă **după** deadline-ul proiectului — either the milestone is wrong or the
     deadline is, and the user has to say which;
   - o bornă majoră **fără nicio muncă între ea și azi** — nothing in the tracker
     leads to it, so either work is missing or the date is decoration;
   - două borne **în aceeași zi** — the timeline draws them as one point, so say so
     before the user discovers it visually;
   - `launch_stage = 'in_production'` cu o bornă de lansare **încă neatinsă** — one of
     the two is stale;
   - o bornă a cărei dată **nu e atinsă de ritmul măsurat** — say it with the number
     („la 0,37 funcționalități/h și 218h rămase, 15 octombrie cere 1,6× ritmul de
     acum"), not as an opinion.

## Mutarea unei borne

A move needs a **written reason**, recorded in `note`. This is the `/amana`
discipline, for the same reason: a milestone moved silently is a milestone that
will move again next month, and nobody will remember that it is the third time.

Ask what changed. If the answer is „n-am apucat", that is not a reason to move the
threshold — it is a reason to look at what is between today and it. Say that.

## Ce NU face

- **Nu atinge `tt_delivery_profiles.deadline`.** If the conversation concludes that
  the project deadline itself must move, say so and send the user to Productivitate.
  That date has its own place and its own gate; changing it from here would put the
  same fact in two hands.
- **Nu inventează borne** pentru a umple linia. A project with two real thresholds
  has two dots.
- **Nu marchează atinsă** o bornă în locul omului, dacă atingerea nu e vizibilă în
  tracker. „Toate secțiunile livrate" se poate verifica; „am trimis pe App Store" nu.
- **Nu șterge** fără confirmare, și niciodată în lot.

## Tabelul

`tt_milestones` — `project_id` (NOT NULL, CASCADE), `title`, `due_date` (date),
`importance` (`mini` | `major`), `done_at` (timestamptz, NULL = neatinsă), `note`.

`note` poartă două lucruri, în ordinea asta: **ce intră în bornă**, ca referințe
de tracker pe care le poate citi o mașină — `#315`, `#319` pentru bug/feature/To-Do
(prefixate cu tipul când numărul singur ar fi ambiguu: `bug #12`, `todo #4`) și
`secțiune <stable_key>` pentru o secțiune UI — apoi motivul unei mutări, dacă a
fost mutată. `/plan-deadlines` citește exact aceste referințe (faza 1, 6b) ca să
ranking-uiască taskurile bornei după data ei, nu după deadline-ul proiectului; o
bornă fără referințe e pentru el doar o dată pe linie. Când omul îți spune ce
intră într-o bornă, scrie referințele în `note` și treci itemele din `Propus` în
`Planificat`, cu confirmarea lui.

Starea nu e o coloană: `done_at` e faptul, iar „ratată" se derivă din `due_date <
azi`. Nu adăuga un `status` — ar trebui împrospătat zilnic de cineva și ar minți
între împrospătări.

`importance = 'major'` e pentru pragurile care **mută proiectul** — lansare,
submisie, demo cu clientul. Nu pentru cele care doar avansează munca. Dacă totul e
major, nimic nu e: pe linie se vede exact la fel ca un rând de buline egale.

## Unde se vede

Productivitate → proiectul selectat → panoul **Borne**. Linia pornește de azi, ca
viitorul apropiat să nu se comprime; bornele atinse din trecut ies din fereastră și
rămân un contor, cu un comutator care le aduce înapoi. O bornă trecută și neatinsă
**nu iese niciodată** — e restanță, se ancorează la marginea din stânga și se vede
roșie.

Deadline-ul proiectului apare pe linie ca bulină mare, citit din profil, fără
butoane de editare. Așa se vede că nu e o bornă ca celelalte.
