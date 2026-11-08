VERSION ?= 0.3.0

.PHONY: build test release
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o bin/fork ./cmd/fork

test:
	go test -race ./...

release:
	mkdir -p dist
	@for platform in linux darwin; do for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=$$platform GOARCH=$$arch go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o dist/fork-agent-$$platform-$$arch ./cmd/fork || exit 1; \
	done; done
	cd dist && shasum -a 256 fork-agent-linux-amd64 fork-agent-linux-arm64 fork-agent-darwin-amd64 fork-agent-darwin-arm64 > SHA256SUMS
