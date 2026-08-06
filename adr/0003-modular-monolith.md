# ADR-0003: Modular monolith with PostgreSQL-backed jobs

- Status: Accepted
- Date: 2026-08-06

## Context

The product needs reliable transactions and a small operational footprint. Microservices and multiple infrastructure datastores would slow a small team.

## Decision

Use a React web app, Fastify modular API, one worker, PostgreSQL, private object storage, and a private Gotenberg service. Use PostgreSQL-backed jobs when asynchronous work arrives.

## Consequences

Module boundaries are enforced in code and review, not network calls. Redis, Kafka, Kubernetes, and microservices require measured triggers and a new ADR.
