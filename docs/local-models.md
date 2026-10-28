# Local summarization with Ollama

Broke can send eligible older conversation messages to a local Ollama model
when `summarize.via` is `local` (the default). This avoids an additional
cloud summarizer request. The main task still uses its configured model,
and the resulting summary is sent to that model on later calls.

Local execution consumes compute and time. Summary quality and latency
depend on the model, quantization, context size and available CPU/GPU memory.
The earlier version of this page listed GPU fit and tokens-per-second figures
as if they had been measured on an RTX 3050 laptop; they were estimates, not
reproducible benchmark results, and have been removed.

## Set up

The configured default model is `qwen2.5-coder:3b`. Its published Ollama
artifact is about 1.9 GB on disk; that figure does not guarantee it will fit
entirely in a particular GPU's memory. See the
[Ollama model listing](https://ollama.com/library/qwen2.5-coder/tags).

```powershell
ollama pull qwen2.5-coder:3b
ollama list
```

Start the Ollama service if it is not running, then check `/broke status` in
AiderDesk to check reachability and whether the configured model is
installed when local summarization is selected. The badge's Check setup action
checks the displayed settings and installed-model metadata without saving
configuration or generating a summary. A remote Ollama address needs explicit
consent before checking. Ollama HTTP redirects are refused for both status
checks and generation; configure the final endpoint URL directly. Consent for
a remote address does not enable redirects. The separate `/broke selftest` uses synthetic input and
a stub summarizer; it does not contact Ollama. Neither check verifies generation,
quality or speed of the configured local model. To assess a local model,
try it on a representative long task and inspect the summary, latency,
`/broke measure` character counts and provider-reported usage.

```text
/broke level summarize
/broke summarize model qwen2.5-coder:3b
/broke summarize via local
```

If Ollama is unavailable, local summarization is skipped after failures;
the other eligible passes can still run. A cloud summarizer is available
through `/broke summarize via cloud`, with an additional provider request
and its associated cost and privacy implications.
