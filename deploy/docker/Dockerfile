# The Go server in a container. Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t etherchat .
FROM golang:1.27 AS build
WORKDIR /src
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /etherd ./cmd/etherd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /etherd /usr/local/bin/etherd
VOLUME /data
ENTRYPOINT ["/usr/local/bin/etherd"]
CMD ["serve", "--config", "/data/etherd.toml"]
