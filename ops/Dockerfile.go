# Multi-stage build of apps/settlement. Build context is the repo root.
# time/tzdata is embedded by cmd/settlement, so the runtime image needs no
# OS zoneinfo for Asia/Bahrain.
FROM golang:1.22-alpine AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement \
    && go clean -cache

FROM alpine:3.20
RUN adduser -D -H -u 10001 settlement
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
USER settlement
EXPOSE 8091
CMD ["./settlement", "daemon"]
