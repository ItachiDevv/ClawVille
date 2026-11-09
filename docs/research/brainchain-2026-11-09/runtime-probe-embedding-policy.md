# Runtime probe embedding policy research

Observed: 2026-11-09 on itachi222. No provider request or reservation occurred.

The repository pins text-embedding-3-small,1536dimensions and the OpenAI embeddings endpoint.
Both standalone embedding calls and the Eliza embedding plugin use these pins.
The existing runtime provider path does not supply durable per-probe cost accounting.

The official model page lists0.02USD per million input tokens.
Source: [OpenAI model specification](https://developers.openai.com/api/docs/models/text-embedding-3-small).
The main pricing page did not expose an embedding row in the fetched document; the model page supplies this observation.

The API reference limits each input to8192tokens and returns prompt_tokens and total_tokens usage.
It accepts a string or multiple inputs. The proposed probe adapter permits one string only.
Source: [OpenAI embeddings reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

For one accepted maximum-length input, the observed tariff gives163.84microUSD.
Rounding upward gives164microUSD. A proposed200microUSD reservation adds a conservative buffer.
This is a calculation from the published model limit, not a local tokenizer estimate or an approved reservation.
The implementation must bound request bytes, enforce one attempt, and reject unsupported models, dimensions and endpoints.
The implementation must validate response usage and retain the maximum liability after an uncertain response.
Provider contract drift requires a new reviewed policy before dispatch.

The first probe uses an eight-minute absolute sequence limit.
This fits within the existing root document's ten-minute maximum lifetime and reserves time for cleanup.
No automatic root renewal or longer authority lifetime belongs to this initial probe.
The actual batch ceiling must derive from the pinned protocol and curriculum section counts.
Existing spend and uncertain allocations still count against the same cumulative OpenAI cap.
OpenRouter receives no allocation for this embedding-only probe.
