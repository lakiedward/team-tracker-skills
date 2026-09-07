# Execuție locală și verificare în browser

Contract comun tuturor skill-urilor Team Tracker, inclusiv când sunt invocate direct,
fără `/proiect` înainte.

- Execută lucrul în checkout-ul sau worktree-ul local al proiectului, în sesiunea curentă.
  Nu trimite taskurile către agenți cloud și nu configura servicii de dispatch la distanță.
  Păstrează modelul și instrumentele disponibile în clientul curent.
- **În ChatGPT/Codex, poți folosi `@Browser`, browserul integrat în IDE, sau `@Chrome`.**
  Alege opțiunea potrivită verificării, dintre instrumentele de browser disponibile în
  sesiune. Pornește serverul local, deschide URL-ul lui în browserul ales și parcurge
  scenariul afectat pe viewportunile relevante. Verificarea vizuală și end-to-end include
  consola și capturi când sunt necesare pentru dovedirea rezultatului.
- Referințele din skilluri la `Claude Preview`, `mcp__Claude_Preview__*` sau
  `.claude/launch.json` descriu serverul și operațiile de preview din Claude. În
  ChatGPT/Codex, folosește comenzile repo-ului și instrumentele de browser disponibile pentru
  aceleași operații. Disponibilitatea unui tool cu numele Claude nu este o condiție.
- Dacă browserul ales nu este disponibil, folosește alt browser accesibil în sesiune. Dacă
  nu poți executa verificarea cu niciunul, raportează exact scenariile rămase neverificate.
  Nu declara testarea UI reușită și nu închide taskul ca verificat doar fiindcă build-ul
  sau testele automate trec.
- Dovezile includ URL, viewport/dispozitiv, pași executați, rezultat observat, capturi
  relevante și starea erorilor din consolă. Păstrează convențiile și porțile de verificare
  ale skillului, inclusiv verificarea SQL pentru taskurile fără UI.
- Include regula de execuție locală și opțiunile `@Browser` / `@Chrome` în prompturile de implementare sau
  testare produse de skill. Review-ul GitHub Bugbot și pașii de merge ai proiectului
  rămân aplicabili; execuția locală nu îi înlocuiește.
- Pentru modificările autorizate, finalizează autonom commit, push, PR și merge după
  verificările și review-urile cerute de proiect, fără a aștepta o confirmare suplimentară
  pentru fiecare pas de livrare. Respectă porțile umane existente și include în commit
  doar fișierele taskului. O sesiune care nu schimbă fișiere nu are nevoie de commit sau PR.

Aceste instrucțiuni de browser privesc testarea aplicației. Citirea unei facturi sau a unui
dashboard extern autentificat, cum face `/supabase-cota`, folosește integrarea și
sesiunea autorizate pentru sursa respectivă.
