# Elasticsearch Observability Queries

Elasticsearch stores full prompt/response traces for provider execution.

PostgreSQL remains the structured source of truth. Elasticsearch is for debugging, searching AI outputs, and provider observability.

## Indexes

The backend uses one index per provider:

```text
openai-responses
gemini-responses
claude-responses
```

Indexes are created automatically before trace documents are written.

You can also create/check them manually:

```bash
npm run elasticsearch:setup
```

## Health Check

```bash
curl http://127.0.0.1:9200
```

Cluster health:

```bash
curl http://127.0.0.1:9200/_cluster/health?pretty
```

## List Indexes

```bash
curl "http://127.0.0.1:9200/_cat/indices?v"
```

Only provider indexes:

```bash
curl "http://127.0.0.1:9200/_cat/indices/*-responses?v"
```

## Check Mapping

```bash
curl "http://127.0.0.1:9200/openai-responses/_mapping?pretty"
```

```bash
curl "http://127.0.0.1:9200/gemini-responses/_mapping?pretty"
```

```bash
curl "http://127.0.0.1:9200/claude-responses/_mapping?pretty"
```

## Count Documents

All provider traces:

```bash
curl "http://127.0.0.1:9200/*-responses/_count?pretty"
```

One provider:

```bash
curl "http://127.0.0.1:9200/gemini-responses/_count?pretty"
```

## Search All Traces For A Domain

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "domain": "figma.com"
      }
    },
    "sort": [
      { "timestamp": "desc" }
    ]
  }'
```

## Search Failed Provider Runs

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "status": "failed"
      }
    },
    "_source": [
      "domain",
      "llm_name",
      "top_k",
      "status",
      "error_type",
      "error_message",
      "timestamp"
    ],
    "sort": [
      { "timestamp": "desc" }
    ]
  }'
```

## Search Completed Provider Runs

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "status": "completed"
      }
    },
    "_source": [
      "domain",
      "llm_name",
      "top_k",
      "rank_position",
      "mention_count",
      "provider_score",
      "overall_geo_score",
      "timestamp"
    ],
    "sort": [
      { "timestamp": "desc" }
    ]
  }'
```

## Search By Provider

Gemini traces:

```bash
curl -X POST "http://127.0.0.1:9200/gemini-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "match_all": {}
    },
    "sort": [
      { "timestamp": "desc" }
    ]
  }'
```

## Search Prompt/Response Text

Find observability responses mentioning competitors:

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "match": {
        "observability_prompt_response": "competitors"
      }
    },
    "_source": [
      "domain",
      "llm_name",
      "observability_prompt_response",
      "timestamp"
    ]
  }'
```

Find scoring prompt responses mentioning a brand:

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "match": {
        "scoring_prompt_response": "Figma"
      }
    },
    "_source": [
      "domain",
      "llm_name",
      "top_k",
      "scoring_prompt_response",
      "provider_score"
    ]
  }'
```

## Aggregate Average Provider Score

```bash
curl -X POST "http://127.0.0.1:9200/*-responses/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "size": 0,
    "aggs": {
      "by_provider": {
        "terms": {
          "field": "llm_name"
        },
        "aggs": {
          "avg_provider_score": {
            "avg": {
              "field": "provider_score"
            }
          }
        }
      }
    }
  }'
```

## Delete Provider Indexes

Only use this for local reset:

```bash
curl -X DELETE "http://127.0.0.1:9200/openai-responses,gemini-responses,claude-responses"
```

Then recreate:

```bash
npm run elasticsearch:setup
```
