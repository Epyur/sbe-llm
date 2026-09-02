FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY go.sum ./
COPY *.go ./
RUN GOFLAGS=-mod=mod CGO_ENABLED=0 GOOS=linux go build -trimpath -o /mailers-llm .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /mailers-llm /mailers-llm
EXPOSE 3000
ENTRYPOINT ["/mailers-llm"]
