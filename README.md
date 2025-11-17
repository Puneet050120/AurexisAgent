# Aurexis Autonomous Agent

An intelligent autonomous agent that breaks down complex user queries into executable tasks, orchestrates their execution with dependency management, and delivers comprehensive results. Built with Next.js and designed for production deployment on Vercel.

## What It Does

The agent supports multiple tools: web search (via Tavily), weather API, calculator, and stock data. Tasks can depend on each other, creating a directed acyclic graph (DAG) that ensures proper execution order.

## Architecture

### Core Components

The system follows a three-phase architecture:

```
User Query → Query Processing → Planning → Execution → Summarization → Response
```

**Query Processor** (`lib/agent/query-processor.ts`)
- Normalizes and cleans user input
- Removes filler words and unnecessary phrases
- Extracts intent and key entities

**Planner** (`lib/agent/planner.ts`)
- Uses LLM (OpenRouter with GPT-4o-mini) to generate task plans
- Creates tasks with proper dependencies
- Validates task structure and dependencies
- Optimized for sub-8-second response time
- Includes fallback plan generation if LLM fails

**Executor** (`lib/agent/executor.ts`)
- Executes tasks in topological order (respects dependencies)
- Parallel execution with bounded concurrency (max 3 concurrent tasks)
- Handles task failures gracefully
- Extracts parameters from task descriptions and dependency results

**Summarizer** (`lib/agent/summarizer.ts`)
- Combines task results into coherent narrative
- Formats different result types (weather, stocks, calculations, search)
- Extracts and includes source citations
- Provides contextual explanations for calculations

### Tool Ecosystem

**Web Search** (`tools.ts`)
- Powered by Tavily API
- Returns structured results with summaries
- Extracts entities and key information

**Weather API**
- OpenWeatherMap integration
- Returns temperature, conditions, humidity, wind speed

**Calculator**
- Safe expression evaluation (no `eval`, uses shunting-yard algorithm)
- Supports Math.max, Math.min, average functions
- Handles currency conversions, CAGR calculations

**Stock Data**
- Alpha Vantage API integration
- Real-time stock prices and market data

## Key Features

### Intelligent Caching

The agent implements a two-tier caching strategy:

- **Upstash Redis** (production): Distributed cache with 24-hour TTL
- **In-memory fallback** (local/dev): Fast local cache when Redis isn't available

Cache keys are generated from task tool, description, and stable parameters. This means identical tasks (same query, same parameters) return instantly without re-execution. The cache is checked **before** any tool execution, preventing unnecessary API calls.

```typescript
// Cache key includes: tool, description, and minimal stable params
// Example: web_search + "current Bitcoin price" + query string
```

### Retry & Fallback Mechanisms

**Tool Execution Retries**
- Each tool call retries up to 3 times on failure
- Exponential backoff between retries
- Graceful degradation if all retries fail

**Planning Fallbacks**
- If LLM planning fails or times out (>8 seconds), generates rule-based fallback plans
- Fallback plans handle common patterns: weather queries, stock lookups, calculations
- Ensures the agent always produces a plan, even if LLM is unavailable

**API Error Handling**
- Network timeouts (5s per request)
- Automatic retries with exponential backoff
- Graceful error messages in UI

### Dependency Management

Tasks can depend on other tasks, creating a DAG:

```
task-1: Search for trending movies
  ↓
task-2: Fetch IMDb ratings (depends on task-1)
  ↓
task-3: Recommend best movie (depends on task-2)
```

The executor uses topological sorting to determine execution order and runs independent tasks in parallel for maximum efficiency.

### Rate Limiting

Built-in rate limiting prevents abuse:
- Per-client rate limiting based on IP/user identifier
- Configurable limits (default: reasonable thresholds)
- Returns proper HTTP 429 with Retry-After headers



### Running Locally

```bash
# Development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

The app will be available at `http://localhost:3000`.


## Project Structure

```
AurexisAgent/
├── app/
│   ├── api/
│   │   └── agent/
│   │       └── stream/          # SSE streaming API endpoint
│   ├── layout.tsx               # Root layout
│   └── page.tsx                 # Home page
├── components/
│   └── ChatInterface.tsx        # Main chat UI component
├── lib/
│   ├── agent/
│   │   ├── cache-client.ts      # Caching abstraction (Redis + in-memory)
│   │   ├── executor.ts          # Task execution engine
│   │   ├── planner.ts            # LLM-based planning
│   │   ├── query-processor.ts    # Query normalization
│   │   ├── summarizer.ts         # Result synthesis
│   │   └── tools.ts              # Tool implementations
│   ├── types/
│   │   └── agent.ts             # TypeScript type definitions
│   └── utils/
│       ├── rate-limit.ts         # Rate limiting logic
│       └── topological-sort.ts   # DAG sorting algorithm
└── docker-compose.yml            # Local Redis setup
```

## How It Works: Example Flow

Let's trace through a real query:

**User asks**: "Get the top 5 trending movies today, fetch IMDb ratings, and recommend the best one"

1. **Query Processing**
   - Input normalized: "top 5 trending movies today fetch IMDb ratings recommend best"

2. **Planning** (LLM generates plan)
   ```
   task-1: Search for "top 5 trending movies today" [web_search]
   task-2: Search for "IMDb ratings for [movies from task-1]" [web_search, depends: task-1]
   task-3: Calculate Math.max(ratings) [calculator, depends: task-2]
   ```

3. **Execution**
   - task-1 runs → returns movie list
   - task-2 runs (uses movies from task-1) → returns ratings
   - task-3 runs (uses ratings from task-2) → returns highest rating
   - All tasks cached for 24 hours

4. **Summarization**
   - Combines results: "Based on current trends, [Movie X] has the highest IMDb rating (8.5/10) and is recommended for tonight."

5. **Response**
   - Streamed to UI via Server-Sent Events (SSE)
   - Real-time updates as tasks complete

## Performance Optimizations

- **Sub-8-second planning**: Fast LLM model (GPT-4o-mini) with strict timeout
- **Parallel execution**: Independent tasks run concurrently (max 3 at once)
- **Early caching**: Cache checked before any tool execution
- **Edge runtime**: Low-latency execution on Vercel Edge
- **Streaming responses**: UI updates in real-time, no waiting for full completion
