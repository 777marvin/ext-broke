# Cache-Friendly Mode — Task Checklist

Plan: tasks/plan.md (Stand 2026-09-09). Abstimmungsstand: Variante B
(kostenoptimiert, Escape-Hatch), Provider-Profile anthropic/openai/off mit
'auto'-Heuristik, UI = Onboarding A + Presets, Einstieg per Klick in die
broke-Settings.

## Task 1: Host-Fakten verifizieren (Spike) — [x]
Befunde (verifiziert 2026-09-09 gegen SDK 0.32 index.d.ts + AiderDesk-Source):
- onOptimizeMessages-Metadaten: Event traegt NICHTS, aber task.data
  {provider, model, mainModel} + getTaskAgentProfile() sind verfuegbar
  (tests/host-contract.test.ts:59). 'auto'-Heuristik machbar.
- Settings-Oeffnen per Host-API: NICHT vorhanden. executeExtensionAction ist
  extension-scoped (ExtensionComponentRenderer.tsx:36); broke-Settings rendert
  der Host nur in der Extensions-Page (ExtensionCard.tsx ->
  ExtensionSettingsDialog.tsx). Deep-Link openSettingsPage('extensions', ...)
  ohne Extension-Auswahl (Settings.tsx liest keine initialOptions dafuer).
  => Task 7 braucht Fallback: broke-eigene Overlay-Settings (UI-Komponente)
  oder Verweis auf Host-Settings. ENTSCHEIDUNG OFFEN (User).
- Message-Identitaet: ContextMessage.id: string (host-seitig stabil,
  BaseContextMessage) => Ledger keyed by id.
  (Task 3 korrigiert: Content-Hash statt id - id-Churn ueberlebt der
  Byte-Vergleich trotzdem, siehe tests/cache.test.ts.)
- BONUS: ContextMessage.usageReport enthaelt cacheWriteTokens /
  cacheReadTokens / messageCost (provider-reported!) => Task 6 kann echte
  Cache-Zahlen melden statt chars/4-Schaetzung.

## Task 2: Config-Schema cache + Profil-Resolver — [x]
CacheSchema (profile: auto|anthropic|openai|off, default 'off';
escapeHatch default true) + resolveCacheProfile (explizit > Modell-Sniff >
Provider-Name > 'off'). tests/config.test.ts 34/34, tsc clean, Vollsuite
482/482.
## Task 3: Sent-Ledger Modul — [x]
cache.ts: markSent/isSent/clearTask/ledgerStats, Content-Hash (SHA-256 ueber
{role, content, toolCallId}), FIFO 2000/Task, Task-LRU 50. tests/cache.test.ts
10/10 (inkl. id-Churn via Content-Match, hostile Input).
## Task 4: Pass-Gating + Byte-Stabilitaetstest — [x]
structuralPass/errorPass/truncatePass nehmen frozen-Praedikat (compress.ts),
index.ts wired isSent + markSent (mark-on-return). E2E Byte-Stabilitaet
(tests/cache-mode.test.ts): Run N ext Run N-1 byte-for-byte; 'off'-Kontrolle
rewritet. Merge-Re-Derivation deterministisch.
## Task 5: Escape-Hatch mit Hysterese — [x]
Option B in compressMessages: Run startet ueber Budget + Hatch offen => EINE
bewusste Komplett-Rewrite (Cache-Verlust einmalig), dann locked bis ein Run
unter Budget startet; escapeHatch:false touchiert Sent-Bytes nie; onEscape
resettet das Ledger (Stabilitaet etabliert sich auf dem Escape-Output neu).
Summarize-Gating (aus Task 4 verschoben): Generate-Pfad blockiert wenn
Region Sent-Bytes enthaelt oder die servierte Summary bereits gesendet war;
inkrementelle byte-stabile Form erzwungen; History-Edit unter gesendeter
Summary => Region unberuehrt (Korrektheit vor Cache). State-Machine laeuft
VOR dem shouldCompress-Fruehreturn (Under-Budget-Run locked frei). Task-Reset
raeumt jetzt auch Ledger + Escape-State auf. 506/506, tsc clean.
## Task 6: Cache-aware Pricing + Measure-Ledger — [x]
pricing.ts: cacheRates (anthropic write 1.25x/read 0.1x, openai write 1x/
read 0.5x, off 1x/1x) + cacheAdjustedSavedUsd (entfernte Tokens als neuer
Input inkl. Write-Premium). tokens.ts: LastCallUsage + lastCallUsage
(rueckwaerts zur neuesten usageReport - provider-reportierte Zahlen statt
Schaetzung), RunRecord += cacheProfile/escaped/lastSentTokens/
lastCacheWriteTokens/lastCacheReadTokens/lastMessageCost (optional,
abwaertskompatibel), MeasureSummary += escapes + Cache-Summen + savedUsd/
cacheSavedUsd (nur mit bekanntem Preis). compress.ts: report.cacheProfile/
escaped. index.ts: profile in cacheOpts, lastCallUsage in recordReport,
/broke measure threaded Preis + Profil. commands.ts: formatMeasure zeigt
Escape-Rewrites, provider-Cache-Snapshot und cache-adjustierte Kosten.
E2E: Escape-Record verifiziert (Run 2 escaped, Run 3 nicht). 519/519, tsc
clean, validate:ui PASS.
## Task 7: Settings-UI (Tooltips + Presets + Einstieg) — [ ]
ENTSCHEIDUNG (User, 2026-09-09): Einstieg = broke-eigenes Overlay-Settings-UI
(Button → Overlay mit voller broke-Konfiguration), kein Verweis-Dialog.
## Task 8: Doku (README, overview, CHANGELOG) — [ ]
## Task 9: Release (MINOR bump, Tag, Signatur) — [ ]

## Checkpoints
- [x] Phase 1 (nach Task 2): Tests gruen, tsc clean
- [x] Phase 2 (nach Task 5): Byte-Stabilitaet gruen, 'off' regressionssicher
- [ ] Phase 3 (nach Task 7): UI validiert, Pricing konsistent
- [ ] Release-Bereitschaft (nach Task 9)
