# Implementation Plan: Cache-Friendly Mode (Prompt-Caching respektieren)

## Overview

Broke komprimiert den Kontext vor jedem Model-Call (`onOptimizeMessages`). Jeder Rewrite
bereits gesendeter Historie invalidiert den Provider-Prompt-Cache — bei Anthropic mit
1,25x Write-Premium fürs Neuaufbauen, bei OpenAI mit Verlust des 0,5x-Cache-Rabatts.
Der Cache-Friendly Mode macht broke cache-bewusst: bereits gesendeter Content wird
niemals umgeschrieben (Sent-Ledger), ausser beim bewussten Budget-Escape-Hatch
(kostenoptimierte Variante B). Regeln und Kostenmodell sind provider-spezifisch
(Anthropic / OpenAI / aus). Konfiguration per Klick in der broke-Settings-UI, jede
Option mit kleinem Onboarding (Tooltip), Presets als Einstieg.

## Architecture Decisions

1. **Kostenoptimiert (Variante B)**: Sent-Prefix ist heilig, aber eine echte
   Ueberschreitung von `maxContextChars` darf einmalig einen teuren Rewrite triggern
   (bekannter, bewusster Cache-Verlust). Mit Hysterese: kein neuer Rewrite, bis das
   Budget wieder unterschritten wurde.
2. **Provider-Profile via Config**: `cache.profile: 'auto' | 'anthropic' | 'openai' | 'off'`.
   Explizites Profil schlaegt Heuristik; `auto` matcht Provider/Model-Metadaten;
   unbekannt -> `off` (aktuelles Verhalten, kein Risiko). Default `off` — bewusster
   Opt-in, konsistent mit bestehenden Consent-Gates (z. B. `summarize.allowRemoteHost`).
3. **Sent-Ledger**: Pro Task eine Menge von Content-Hashes (SHA-256, vorhandenes
   Muster aus `cachedSummaryByTask`) der Nachrichten, die in einem frueheren
   `onOptimizeMessages`-Return enthalten waren. Optimistisch markiert (mark-on-return):
   faelschlich als gesendet markierte Nachrichten kosten nur eine verpasste
   Kompressions-Chance, niemals einen Cache-Bruch. In-Memory pro Task (Muster wie
   `cachedSummaryByTask`), Persistenz als Follow-up.
4. **Provider-Regeln — Gating gleich, Kostenmodell unterschiedlich**: Die
   Unverletzlichkeits-Regeln sind bei Anthropic und OpenAI identisch (Prefix nicht
   anfassen); der Unterschied liegt im Preismodell (Anthropic: Write 1,25x / Read 0,1x;
   OpenAI: auto ab 1024 Tokens, Read 0,5x, kein Write-Premium) und damit in der
   Escape-Hatch-Kostenabwaegung. `off` = heutiges Verhalten unveraendert.
5. **Cache-sichere Operationen bleiben erlaubt**: Verbatim Re-Splice eines
   unveranderten region-summary (produziert identische Bytes -> kein Invalidierung)
   und deterministische, bereits gesendete Bytes unveraendernde Operationen sind
   auch im Strict-Modus erlaubt. Verboten sind: Merge aufeinanderfolgender
   Assistant-Texts an gesendeten Nachrichten, errorPass/truncatePass auf gesendeten
   Nachrichten, Summarize-Head-Rewrite der gesendeten Region (ausser Escape-Hatch).
6. **UI: Onboarding-Stufe A + Presets**: Jede Option 1-2-Satz-Tooltip (host
   `Tooltip`-Primitive); Preset-Buttons "Cache-optimiert" / "Standard" /
   "Maximal komprimiert" als kohaerente Option-Buendel. Kein Wizard (YAGNI).
7. **Cache-aware Pricing**: `pricing.ts` erhaelt Cache-Write/-Read-Multiplikatoren
   pro Profil; das measure-Ledger berichtet cache-adjusted Savings (Netto inkl.
   Write-Premium bzw. verlorenem Read-Rabatt).

## Task List

### Phase 1: Verifikation + Fundament

- [ ] **Task 1: Host-Fakten verifizieren (Spike, kein Code)**
  Beschreibung: Drei unbelegte Annahmen pruefen, bevor gebaut wird.
  Akzeptanzkriterien:
  - [ ] Festgestellt, ob der `onOptimizeMessages`-Event Model-/Provider-Metadaten
        traegt (vendored Host-Types `@aiderdesk/extensions` + ggf. AiderDesk-Repo);
        Ergebnis notiert in tasks/todo.md.
  - [ ] Festgestellt, ob eine Host-API "Settings-Panel der Extension oeffnen"
        existiert (`executeExtensionAction`-Katalog); Fallback definiert
        (Badge-Action oder `/broke`-Command-Hinweis).
  - [ ] Festgestellt, ob ContextMessages stabile IDs tragen oder Content-Hash
        die richtige Ledger-Key-Strategie ist.
  Verifikation: Befunde als Notiz in tasks/todo.md; keine Code-Aenderung.
  Dateien: keine (recherche). Scope: XS.

- [ ] **Task 2: Config-Schema `cache` + Profil-Auflösung**
  Beschreibung: `CacheSchema` in config.ts (`profile`-Enum, `escapeHatch` Boolean,
  Default `profile:'off'`, `escapeHatch:true`), plus reine Resolver-Funktion
  `resolveCacheProfile(config, hostHints)` (explizit > Heuristik > 'off').
  Akzeptanzkriterien:
  - [ ] Explizites Profil schlaegt Heuristik, Heuristik schlaegt 'off'.
  - [ ] Heuristik: anthropic/bedrock-anthropic/openrouter-claude -> 'anthropic';
        openai/gpt/o*-Familie -> 'openai'; ollama/local/leer -> 'off'.
  - [ ] Partial-Config (fehlender `cache`-Block) bleibt valide (Bestandsmuster).
  Verifikation: `npx vitest run tests/config.test.ts` (neue Faelle), `npx tsc --noEmit`.
  Dateien: config.ts, tests/config.test.ts. Scope: S.

### Checkpoint Phase 1: Tests gruen, tsc clean, Befunde dokumentiert.

### Phase 2: Kern — Sent-Ledger + Pass-Gating

- [ ] **Task 3: Sent-Ledger Modul**
  Beschreibung: Neues Modul (z. B. cache.ts): pro Task Hash-Set, API
  `markSent(taskId, messages)` / `isSent(taskId, message)` / `clearTask(taskId)`.
  Akzeptanzkriterien:
  - [ ] Mark-on-return ist optimistisch; Hashes deterministisch (SHA-256 ueber
        kanonischer Message-Serialisierung).
  - [ ] Ledger wächst begrenzt (Cap + FIFO-Eviction, dokumentiert).
  Verifikation: neue tests/cache.test.ts, `npx vitest run tests/cache.test.ts`.
  Dateien: cache.ts (neu), tests/cache.test.ts. Scope: S.

- [ ] **Task 4: Pass-Gating im Pipeline-Pfad**
  Beschreibung: compress.ts respektiert das aufgeloeste Profil: unter Budget
  werden gesendete Nachrichten von structural-merge, errorPass und truncatePass
  ausgenommen; Summarize-Head-Rewrite nur via Escape-Hatch; verbatim Re-Splice
  (identische Bytes) bleibt erlaubt. `off` = exakt heutiges Verhalten.
  Akzeptanzkriterien:
  - [ ] Unter Profil 'anthropic'/'openai': kein Byte gesendeter Nachrichten
        veraendert sich zwischen zwei aufeinanderfolgenden Calls ohne Budget-Ueber-
        schreitung (Idempotenz-/Byte-Stabilitaetstest — schliesst die bekannte
        Testluecke aus der Maintainer-Diskussion).
  - [ ] Unter 'off': alle bestehenden Tests unverändert gruen.
  Verifikation: `npx vitest run tests/compress.test.ts tests/cache.test.ts`, tsc.
  Dateien: compress.ts, index.ts (Verdrahtung), tests/compress.test.ts. Scope: M.

- [ ] **Task 5: Escape-Hatch mit Hysterese**
  Beschreibung: Bei `totalCharsBefore > maxContextChars`: einmal voller Pass nach
  level (bewusster Cache-Verlust), danach Sperre bis wieder unter Budget;
  nur wenn `cache.escapeHatch` aktiv.
  Akzeptanzkriterien:
  - [ ] Genau ein Rewrite pro Budget-Kreuzung (Hysterese-Test: Ueberschreiten ->
        Rewrite -> weiter ueber Budget -> kein zweiter Rewrite -> unter Budget ->
        wiederueberschreiten -> Rewrite erlaubt).
  - [ ] `escapeHatch:false` = hartes Versprechen, nie gesendete Bytes anzufassen.
  Verifikation: vitest (compress+cache), tsc.
  Dateien: compress.ts, cache.ts, tests/compress.test.ts. Scope: S-M.

### Checkpoint Phase 2: Byte-Stabilitaetstest gruen; 'off'-Verhalten regressionssicher.

### Phase 3: Kostenmodell + UI

- [ ] **Task 6: Cache-aware Pricing + Measure-Ledger**
  Beschreibung: pricing.ts um Multiplikatoren je Profil erweitern
  (anthropic: write 1,25 / read 0,1; openai: write 1,0 / read 0,5; off: 1/1);
  CompressReport/measure um cache-adjusted Savings-Feld.
  Akzeptanzkriterien:
  - [ ] Preisformeln mit Tests belegt; 'off' liest sich identisch zum heutigen Wert.
  - [ ] Ledger-Eintrag zeigt cache-adjusted vs. naive Ersparnis.
  Verifikation: `npx vitest run tests/pricing.test.ts tests/measure.test.ts`, tsc.
  Dateien: pricing.ts, measure.ts bzw. output.ts (Ledger-Format), Tests. Scope: M.

- [ ] **Task 7: Settings-UI (Sektion, Tooltips, Presets, Einstieg)**
  Beschreibung: ConfigComponent.jsx um Cache-Sektion erweitern (Profil-Select,
  Escape-Hatch-Checkbox, Preset-Buttons), Tooltips je Option (Onboarding A);
  Einstiegspunkt je Task-1-Befund (Host-Action oder Fallback).
  Akzeptanzkriterien:
  - [ ] Alle Props konform zu scripts/host-ui-contract.d.ts; kein `any`-Leak.
  - [ ] Presets setzen kohärente Buendel und sind im JSX nachvollziehbar dokumentiert.
  - [ ] `node scripts/validate-extension-ui.mjs ConfigComponent.jsx` (und StatusBadge
        falls angefasst) laeuft gruen; ui-contract.test.ts erweitert.
  Verifikation: validate-extension-ui + `npx vitest run tests/ui-contract.test.ts`.
  Dateien: ConfigComponent.jsx, ggf. StatusBadge.jsx, tests/ui-contract.test.ts. Scope: M.

### Checkpoint Phase 3: UI validiert, Pricing konsistent.

### Phase 4: Doku + Release

- [ ] **Task 8: Dokumentation**
  Beschreibung: README ("How it works" + Config-Tabelle), docs/overview.md
  (Pass-Beschreibung um Cache-Gating ergänzen), CHANGELOG [Unreleased].
  Akzeptanzkriterien: Doku stimmt mit implementierten Defaults ueberein
  (README-Drift-Guard bench.test.ts bleibt gruen).
  Verifikation: `npx vitest run tests/bench.test.ts`, Vollsuite.
  Dateien: README.md, docs/overview.md, CHANGELOG.md. Scope: S.

- [ ] **Task 9: Freigabe + Release**
  Beschreibung: Vollsuite + tsc + validate-extension-ui gruen; MINOR-Bump
  (neues, rueckwaertskompatibles Feature), Tag, sign-release-Pipeline.
  Akzeptanzkriterien: scripts/check-version.mjs und Signatur-Check gruen.
  Verifikation: `npm test`, Release-Scripts.
  Dateien: package.json, CHANGELOG.md. Scope: S.

## Risks and Mitigations

| Risiko | Impact | Mitigung |
|--------|--------|----------|
| onOptimizeMessages traegt keine Provider-Metadaten | Heuristik 'auto' schwach | Task 1 vorab klaeren; Notfall: explizites Profil ist First-Class ('auto' nur Zucker) |
| Keine Host-API zum Settings-Oeffnen | UX-Erwartung (Klick) | Task-1-Fallback: Badge-Action oder Command; Expectation im Design anpassen |
| Mark-on-return markiert nie wirklich gesendete Nachrichten | Weniger Kompression | Akzeptiert und dokumentiert — Fehlerrichtung ist bewusst konservativ |
| Byte-Stabilitaet durch Host-Seitige Message-Mutationen gefaehrdet | Fehlender Cache-Hit trotz Regel | Idempotenztest (Task 4) macht sichtbar; ggf. Hash-Normalisierung |
| Cost-Optimierung falsch gerechnet (Prefix-Boundary) | Falsche Savings-Berichte | Task 6 testet Formeln gegen dokumentierte Provider-Preise; Quellen im Test verlinkt |

## Open Questions

- Default `escapeHatch:true` (Kostenoptimierung ist der Sinn des Modus) — bestätigt
  aus Variante B, im Task-2-Review nochmal ansehen.
- Ledger-Persistenz ueber Neustarts: bewusst Follow-up (Server-seitiger Cache
  ueberlebt Neustart nur ~5 Min bei Anthropic; Nutzen gering).
- Anthropic Idle-TTL (>5 Min ohne Call -> Cache eh weg, Rewrite "gratis"):
  als optionale Verfeinerung im Task 5 oder bewusst vertagt.
