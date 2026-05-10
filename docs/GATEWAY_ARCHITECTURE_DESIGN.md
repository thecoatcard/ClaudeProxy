# Gateway Design

## High-Level Design

```mermaid
flowchart LR
    Client[Claude Code / Anthropic Client]
    APIRoute[/api/v1/messages]
    Auth[Auth Layer]
    Router[Task Router + Model Router]
    Transformer[Request Transformer]
    Retry[Retry Engine]
    Gemini[Gemini Adapter]
    Response[Response / Stream Transformer]
    Admin[Admin Dashboard]
    AdminAPI[/api/admin/*]
    Redis[(Redis State)]

    Client --> APIRoute
    APIRoute --> Auth
    Auth --> Router
    Router --> Transformer
    Transformer --> Retry
    Retry --> Gemini
    Gemini --> Response
    Response --> Client

    Retry <--> Redis
    Router <--> Redis
    Transformer <--> Redis
    Response <--> Redis

    Admin --> AdminAPI
    AdminAPI <--> Redis
    AdminAPI --> Router
    AdminAPI --> Retry
```

## Request Design

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway Route
    participant R as Router
    participant T as Transformer
    participant E as Retry Engine
    participant M as Gemini Model
    participant X as Response Transformer
    participant D as Redis

    C->>G: Anthropic-compatible request
    G->>G: Extract token + parse body
    G->>R: Resolve task-aware model route
    R->>D: Read routing registry / sticky model
    R-->>G: primary + fallback chain
    G->>T: Transform Anthropic -> Gemini
    T->>D: Read summaries / archives / emergency state
    T-->>G: Gemini body + request context
    G->>E: Execute with retry
    E->>D: Read admin settings / key state
    E->>M: callGemini(primary)
    alt success
        M-->>E: Gemini response
    else overload / timeout / 5xx
        E->>D: Cooldown key + rotate state
        E->>E: Compact context + switch model
        E->>M: Retry on fallback model
    end
    E-->>G: final Gemini response
    G->>X: Transform Gemini -> Anthropic
    X->>D: Persist tool mappings / signatures
    X-->>C: JSON or SSE response
```

## Reliability Design

```mermaid
flowchart TD
    Start[Model call starts]
    Fail{Overload / Timeout / 5xx?}
    Compact[Compact middle turns]
    Cooldown[Cooldown failing key]
    Rotate[Rotate to fresh key]
    Fallback[Move to fallback model]
    Retry[Retry once per chain slot]
    Success[Return response]
    Exhausted[Return overloaded_error]

    Start --> Fail
    Fail -- No --> Success
    Fail -- Yes --> Compact
    Compact --> Cooldown
    Cooldown --> Rotate
    Rotate --> Fallback
    Fallback --> Retry
    Retry --> Success
    Retry --> Exhausted
```

## Admin Control Design

- Dashboard Overview shows current runtime mode, key health, and usage.
- System Controls expose live runtime toggles such as parallel racing on/off.
- Model Routing allows runtime route overrides without redeploying.
- Provider Keys and Gateway Keys are managed separately.
- Admin sessions are backed by Redis and isolated from gateway-user tokens.

## Design Intent

This gateway is designed as a resilient execution coordinator:
- clients keep the Anthropic interface they expect
- gateway owns routing, reliability, and state repair
- Redis provides shared operational memory
- overload is handled by shrinking context and moving across keys/models
- admin can change runtime behavior live without changing code
