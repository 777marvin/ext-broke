# Local models on this stack: what actually works

Hardware facts (verified on this machine, 2026-08):

| Component | Spec |
|---|---|
| Laptop | MSI Thin 15 B12UC |
| CPU | Intel Core i5-12450H (4P + 4E cores) |
| RAM | 15.7 GB (shared with iGPU) |
| GPU | NVIDIA GeForce RTX 3050 Laptop, **4 GB VRAM** |
| Local runtime | Ollama installed (`ollama.exe`), server currently **not running**, no models pulled yet |

The binding constraint is **4 GB VRAM**. Everything below is derived from
that, plus Ollama's default behaviors (Q4 quantizations, KV cache sharing).

## What fits in 4 GB VRAM

| Model tag | Size (Q4) | In VRAM? | Realistic use on this GPU |
|---|---|---|---|
| `qwen2.5-coder:3b` | ~1.9 GB | ✅ fully | fast, good code summaries (Broke default) |
| `llama3.2:3b` | ~2.0 GB | ✅ fully | general text, chat |
| `phi4-mini` (3.8B) | ~2.4 GB | ✅ fully | best reasoning per GB in this class |
| `gemma3:4b` | ~3.3 GB | ✅ fully | multilingual, vision-capable |
| `qwen2.5-coder:7b` | ~4.4 GB | ⚠️ partial offload | works, 2-3× slower than 3B |
| `qwen2.5-coder:14b`, `deepseek-r1:14b`, `gemma2:9b`, 13B+ | > 6 GB | ❌ | not usable interactively on this GPU |

Expected speeds (estimates; measure with `/broke status` + your own runs):
3B Q4 fully in VRAM ≈ **30–60 tok/s** generation, prompt processing much
faster; 7B with partial offload ≈ **8–20 tok/s**. A 400-word summary
(~500 output tokens) takes roughly **10–20 s on a 3B, 30–60 s on a 7B**,
fine for background-style compression, too slow for interactive chat.

## What local models genuinely do well (on this stack)

1. **Summarization & context compression**: the ideal workload: quality
   bar is modest, latency tolerance is high, and every summary produced
   locally saves *all* the cloud input tokens of the turns it replaces.
   This is Broke's `summarize via local` (default).
2. **Small, well-scoped text transformations**: commit message drafting,
   task titling, prompt rewriting, error-message condensation.
3. **Classification / triage**: "is this output an error?", "which
   component does this mention?", simple routing decisions.
4. **Single-file review & lint-style checks**: a 3–4B model can spot
   obvious bugs, missing imports, or style drifts in a file it is given
   fully.
5. **Fully offline / privacy-sensitive work**: small files, no repo map,
   no cloud round-trips at all.

## What local models cannot do (on this stack)

- **Multi-file refactoring and feature work**: the main agent's job needs
  repo map + tool calls + long context, 3–4B models degrade quickly and
  their tool-calling reliability is mediocre. Keep the main loop on a
  cloud model.
- **Long-context reasoning**: 4 GB VRAM caps usable context (8–16k
  comfortably); 32k+ context eats the KV cache and tanks speed.
- **Agentic loops at speed**: every extra step on a slow local model
  compounds latency; local models as *main* agents on this hardware are a
  frustration generator, not a token saver.

## Workflow patterns that work

### 1. Hybrid routing (recommended, zero-config with Broke)

```
cloud model ── main agent loop (files, tools, edits)
      │
      └── context > threshold
            └── Broke summarize ── via local (Ollama) ── summary
                  │                                    (0 cloud tokens)
                  └── summary replaces old turns in the input
```

Cloud handles everything that needs intelligence; the local model only
ever compresses. Net effect: cloud input tokens drop by the size of the
compressed history, and the local work is free.

### 2. Local-only sidecar tasks

Use a second task (or a subagent with a local provider) for: commit
messages, changelog drafting, PR description, simple greps→summaries.
AiderDesk providers must include the local endpoint (Ollama is
OpenAI-compatible: `http://127.0.0.1:11434/v1`); Broke itself talks to
Ollama directly and needs no provider registration.

### 3. Offline fallback

With Ollama + a 3B model pulled, you can still get summaries, short
answers, and single-file reviews without any network. Not a replacement
for the main agent, a safety net.

## Setup

```powershell
# 1. Start the server (or set it to autostart)
ollama serve

# 2. Pull the recommended default
ollama pull qwen2.5-coder:3b

# 3. Verify from AiderDesk
/broke status        # shows ollama reachable + model list + whether the
                     # configured model is installed
/broke selftest      # runs the full pipeline with a stub summarizer
```

Tuning knobs (all via `/broke`):

```powershell
/broke summarize model qwen2.5-coder:7b   # bigger but slower summaries
/broke summarize via cloud               # fall back to cloud summarizer
/broke summarize after 10                # compress less aggressively
```

Note: the Ollama server is currently **not running** on this machine and
no models are pulled. Broke degrades gracefully: local summarization is
simply skipped (and reported in `/broke status` + the activation notice)
until Ollama is up. The built-in emergency compaction still protects you.
