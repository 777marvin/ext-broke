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
- BONUS: ContextMessage.usageReport enthaelt cacheWriteTokens /
  cacheReadTokens / messageCost (provider-reported!) => Task 6 kann echte
  Cache-Zahlen melden statt chars/4-Schaetzung.

## Task 2: Config-Schema cache + Profil-Resolver — [x]
CacheSchema (profile: auto|anthropic|openai|off, default 'off';
escapeHatch default true) + resolveCacheProfile (explizit > Modell-Sniff >
Provider-Name > 'off'). tests/config.test.ts 34/34, tsc clean, Vollsuite
482/482.
## Task 3: Sent-Ledger Modul — [ ]
## Task 4: Pass-Gating + Byte-Stabilitaetstest — [ ]
## Task 5: Escape-Hatch mit Hysterese — [ ]
## Task 6: Cache-aware Pricing + Measure-Ledger — [ ]
## Task 7: Settings-UI (Tooltips + Presets + Einstieg) — [ ]
## Task 8: Doku (README, overview, CHANGELOG) — [ ]
## Task 9: Release (MINOR bump, Tag, Signatur) — [ ]

## Checkpoints
- [ ] Phase 1 (nach Task 2): Tests gruen, tsc clean
- [ ] Phase 2 (nach Task 5): Byte-Stabilitaet gruen, 'off' regressionssicher
- [ ] Phase 3 (nach Task 7): UI validiert, Pricing konsistent
- [ ] Release-Bereitschaft (nach Task 9)
