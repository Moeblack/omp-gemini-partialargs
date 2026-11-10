# omp-gemini-partialargs

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension that adds a Gemini provider with **streamed function-call arguments** (`partialArgs`).

With `streamFunctionCallArguments` enabled, Gemini sends a tool call's arguments in small fragments. The built-in Google provider in omp treats each fragment as a separate, finished call, so tool calls break. This extension registers its own provider that rebuilds those fragments into one correct call and streams them to the UI as they arrive.

## What it does

- Rebuilds `partialArgs` into full arguments, including nested paths (`$.list[0].items[1]`), strings split across chunks, and value-less closing fragments.
- Cleans the chat history before sending it: skips empty, aborted or failed assistant turns (Gemini rejects empty `parts`), and keeps tool results in a separate turn from user text.
- Reports anything unexpected instead of crashing or failing silently. HTTP errors, safety blocks (`promptFeedback.blockReason`), upstream `error` frames, unknown fields or parts, abnormal `finishReason`s and non-JSON frames all end the turn with an error that includes the raw upstream text.

## Install

1. Copy `omp-gemini-partialargs.js` into `~/.omp/agent/extensions/`.
2. Add an `OMP_GEMINI_PROVIDER` line to `~/.omp/agent/.env`, using [`.env.example`](.env.example) as a template. The value is single-line JSON and must be wrapped in single quotes.
3. Start a **new** omp session (extensions load at session start), then pick the model:

   ```
   omp --model gemini-partialargs/gemini-3.8-flash
   ```

## Configuration

`OMP_GEMINI_PROVIDER` is passed straight to omp's `registerProvider`. Formatted for reading:

```json
{
  "name": "gemini-partialargs",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "api": "gemini-partialargs",
  "apiKey": "YOUR_API_KEY",
  "models": [
    {
      "id": "gemini-3.8-flash",
      "name": "Gemini 3.8 Flash (partialArgs)",
      "api": "gemini-partialargs",
      "reasoning": true,
      "input": [
        "text",
        "image"
      ],
      "contextWindow": 1000000,
      "maxTokens": 65536,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    }
  ]
}
```

- `name`: the provider name you will see in omp.
- `baseUrl`: any endpoint that speaks the Gemini `v1beta` `streamGenerateContent` protocol, either Google's API or a compatible gateway.
- `api`: must be `gemini-partialargs`, on the provider and on every model. omp rejects built-in API names here.
- `headers` (optional): extra request headers.
- `models[].cost`: price per million tokens, used for omp's cost display.
- `models[].thinking` (optional): for Gemini 4 models, add `{"mode": "google-level", "efforts": ["low","medium","high"]}`.

## Notes

- Thinking suffixes such as `:low` do not work in `--model` for providers registered by an extension. Use the bare model id.
- When a turn contains a valid tool call and an unexpected frame, the whole turn is reported as an error, so the tool does not run. This is deliberate, so that problems always show up.
- Safety blocks come from Google and cannot be worked around here. The extension only makes them visible.

## License

MIT
